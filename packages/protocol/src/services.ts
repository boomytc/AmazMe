/** Application service contracts and resource ownership on the Chord host runtime. */
import {
	createHost,
	defineRegistry,
	hostPrincipal,
	local,
	method,
	opaque,
	remote,
	resource,
	type AnyContract,
	type Context,
	type Ctx,
	type Facet,
	type FacetApi,
	type Factory,
	type Handle,
	type Host,
	type JsonValue,
	type Readable,
	type ReplicatedState,
	type ServeOptions,
} from "@amazme/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import { diffRevisions } from "@amazme/chord/delta";
import { Type } from "typebox";

export interface ApplicationService<T = unknown> {
	readonly name: string;
	readonly contract: AnyContract;
	readonly methods: readonly string[];
	readonly states: readonly string[];
	readonly valueType?: T;
}
export interface ServiceDescription {
	readonly serviceId: string;
	readonly local?: boolean;
	readonly host?: string;
}
let resourceRevision = 0;
export const ServiceDescriptions = defineRegistry<ServiceDescription>("amazme.services");

/** Positional domain arguments are a single array on the wire; Context is carried by Chord's root. */
export function remoteService<T>(
	name: string,
	methods: Readonly<Record<string, number>>,
	states: readonly string[] = [],
): ApplicationService<T> {
	return {
		name,
		contract: remote(name, {
			version: 1,
			input: Type.Object({}, { additionalProperties: false }),
			variants: {
				default: {
					state: Object.fromEntries(states.map((key) => [key, Type.Unknown()])),
					methods: Object.fromEntries(
						Object.entries(methods).map(([key, count]) => [
							key,
							method(Type.Array(Type.Unknown(), { minItems: count, maxItems: count }), Type.Unknown()),
						]),
					),
				},
			},
		}),
		methods: Object.keys(methods),
		states,
	};
}

/** Native contributions remain in-process objects, explicitly declared as local opaque members. */
export function localService<T>(name: string): ApplicationService<T> {
	return {
		name,
		contract: local(name, {
			version: 1,
			input: Type.Object({}),
			members: { value: opaque<T>(`${encodeURIComponent(name)}@1`) },
		}),
		methods: [],
		states: [],
	};
}

export interface ServiceResolver {
	get<T>(service: ApplicationService<T>): T;
}
export interface ServiceInstance<T> {
	value: T;
	close?(): void | Promise<void>;
}

function domainContext(ctx: Ctx): Context {
	return withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
}

function readable(get: () => ReplicatedState<unknown>): Readable<unknown> {
	return {
		get value() {
			return get().value;
		},
		subscribe: (listener) => get().subscribe((value) => listener(value)),
		events(listener) {
			let previous: unknown;
			let initial = true;
			return get().subscribe((value) => {
				if (initial) {
					initial = false;
					listener({ type: "snap", value });
				} else listener({ type: "ops", value, ops: diffRevisions(previous as JsonValue, value as JsonValue) });
				previous = value;
			});
		},
	};
}

/** A view of a Chord handle used by the product's domain APIs. It owns no transport or execution runtime. */
export function serviceView<T>(
	service: ApplicationService<T>,
	handle: Handle,
	host: Pick<Host, "root">,
	assertAccess = () => {},
	onError: (error: unknown) => void = console.error,
): T {
	const values = handle as unknown as Record<string, unknown>;
	if (service.contract.scope === "local") {
		return new Proxy(
			{},
			{
				get(_target, key) {
					assertAccess();
					const value = values.value as Record<PropertyKey, unknown> | undefined;
					if (value === undefined) throw new Error(`Service ${service.name} is not ready`);
					const member = value[key];
					return typeof member === "function" ? member.bind(value) : member;
				},
			},
		) as T;
	}
	const result: Record<string, unknown> = {};
	for (const name of service.methods)
		result[name] = (...args: unknown[]) => {
			assertAccess();
			const context = args.pop() as Context;
			if (context === undefined || typeof context.value !== "function")
				throw new TypeError(`${service.name}.${name} requires Context`);
			const fn = values[name] as (input: unknown[], ctx: Ctx) => Promise<unknown>;
			return host.root((ctx) => fn(args, ctx), { signal: context.abortSignal });
		};
	for (const name of service.states) {
		const state = values[name] as Readable<unknown>;
		result[name] = {
			get value() {
				return state.value;
			},
			subscribe(
				listener: (
					value: unknown,
					context: Context,
					delivery: { kind: "hydrate" | "update"; sequence: number },
				) => void | Promise<void>,
			) {
				let active = true,
					sequence = 0;
				const pending: Array<{ value: unknown; delivery: { kind: "hydrate" | "update"; sequence: number } }> = [];
				let draining = false;
				const drain = async (): Promise<void> => {
					if (draining) return;
					draining = true;
					try {
						while (active && pending.length) {
							const next = pending.shift()!;
							try {
								await listener(next.value, BACKGROUND_CONTEXT, next.delivery);
							} catch (error) {
								onError(error);
							}
						}
					} finally {
						draining = false;
					}
				};
				const stop = state.subscribe((value) => {
					if (value === undefined) return;
					const delivery = { kind: sequence === 0 ? ("hydrate" as const) : ("update" as const), sequence: sequence++ };
					if (pending.length === 100) pending.length = 0;
					pending.push({ value, delivery });
					void drain().catch(onError);
				});
				return () => {
					active = false;
					pending.length = 0;
					stop();
				};
			},
		} satisfies ReplicatedState<unknown>;
	}
	return result as T;
}

/** One eagerly owned implementation, with remote facades borrowing it under their caller's principal. */
export function serveService<T>(
	api: FacetApi,
	service: ApplicationService<T>,
	options: {
		dependencies?: readonly ApplicationService[];
		descriptions?: readonly ApplicationService[];
		open(services: ServiceResolver, signal: AbortSignal): ServiceInstance<T> | Promise<ServiceInstance<T>>;
	},
): void {
	const revision = ++resourceRevision;
	const backing = local(`${service.name}.implementation`, {
		version: 1,
		input: Type.Object({}),
		members: { value: opaque<ServiceInstance<T>>(`${encodeURIComponent(service.name)}@1`) },
	});
	api.serve(
		backing,
		(_input, _principal, self) => {
			const dependencies = new Map(
				(options.dependencies ?? []).map((dependency) => [
					dependency.name,
					{ dependency, handle: self.get(dependency.contract, {}, { principal: hostPrincipal }) },
				]),
			);
			const implementation = self.resources({
				instance: resource({
					rev: revision,
					exclusive: true,
					deps: [...dependencies.values()].map(({ handle }) => handle),
					open: ({ signal }) =>
						options.open(
							{
								get: <U>(dependency: ApplicationService<U>): U => {
									const found = dependencies.get(dependency.name);
									if (!found) throw new Error(`Undeclared dependency ${dependency.name}`);
									return serviceView(dependency, found.handle, api);
								},
							},
							signal,
						),
					close: (instance) => instance.close?.(),
				}),
			});
			self.register(
				ServiceDescriptions,
				Object.fromEntries(
					(options.descriptions ?? [service]).map((entry) => [
						entry.name,
						{
							serviceId: entry.name,
							...(entry.contract.scope === "local" ? { local: true } : {}),
						},
					]),
				),
			);
			return { value: self.expose(implementation.instance) };
		},
		{ eager: true },
	);
	serveBorrowed(api, service, backing, (value) => (value as ServiceInstance<T>).value);
}

/** Public views borrow one owner; they do not introduce another resource generation. */
function serveBorrowed<T>(
	api: FacetApi,
	service: ApplicationService<T>,
	backing: AnyContract,
	select: (value: unknown) => T,
): void {
	const factory = (_input: unknown, _principal: unknown, self: Parameters<Factory<AnyContract>>[2]) => {
		const implementation = self.get(backing, {}, { principal: hostPrincipal });
		const get = () => select((implementation as unknown as { value: unknown }).value) as Record<string, unknown>;
		if (service.contract.scope === "local")
			return {
				value: new Proxy(
					{},
					{
						get(_target, key) {
							const instance = get();
							const member = instance[key as string];
							return typeof member === "function" ? member.bind(instance) : member;
						},
					},
				),
			};
		const behavior: Record<string, unknown> = { kind: "default" };
		for (const name of service.methods)
			behavior[name] = (args: unknown[], ctx: Ctx) => {
				const instance = get();
				const fn = instance[name] as (...values: unknown[]) => unknown;
				return fn.apply(instance, [...args, domainContext(ctx)]);
			};
		for (const name of service.states) behavior[name] = readable(() => get()[name] as ReplicatedState<unknown>);
		return behavior;
	};
	const serve = api.serve as (contract: AnyContract, factory: Factory<AnyContract>, options?: ServeOptions) => void;
	serve(service.contract, factory as Factory<AnyContract>);
}

/** A product contribution is an eager Chord resource; dependencies and disposal belong to its record. */
export function activationFacet(
	name: string,
	dependencies: readonly ApplicationService[],
	open: (
		services: ServiceResolver,
		signal: AbortSignal,
	) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>,
): Facet {
	const contribution = localService<object>(`${name}.contribution`);
	return {
		name,
		uses: dependencies.map((service) => service.contract),
		setup(api) {
			serveService(api, contribution, {
				dependencies,
				async open(services, signal) {
					const close = await open(services, signal);
					return { value: {}, ...(close ? { close } : {}) };
				},
			});
		},
	};
}

export class ServiceScope implements ServiceResolver {
	readonly #host: Host;
	readonly #at: string | undefined;
	readonly #handles = new Map<string, Handle>();
	readonly #views = new Map<string, unknown>();
	readonly #hydrations: Promise<void>[] = [];
	readonly #subscriptions: (() => void)[] = [];
	#closed = false;
	constructor(host: Host, options: { at?: string } = {}) {
		this.#host = host;
		this.#at = options.at;
	}
	get<T>(service: ApplicationService<T>): T {
		if (this.#closed) throw new Error("Service scope is closed");
		if (!this.#views.has(service.name)) {
			const handle = this.#host.get(service.contract, {}, this.#at === undefined ? {} : { at: this.#at });
			this.#handles.set(service.name, handle);
			for (const name of service.states) {
				const state = (handle as unknown as Record<string, Readable<unknown>>)[name]!;
				const hydration = new Promise<void>((resolve, reject) => {
					this.#subscriptions.push(
						state.subscribe((value) => {
							if (value !== undefined) resolve();
						}),
					);
					this.#subscriptions.push(
						handle.onStatus((status, error) => {
							if (status === "gone" || status === "released")
								reject(error ?? new Error("Service released before hydration"));
						}),
					);
				});
				hydration.catch(() => {});
				this.#hydrations.push(hydration);
			}
			this.#views.set(
				service.name,
				serviceView(service, handle, this.#host, () => {
					if (this.#closed) throw new Error("Service scope is closed");
				}),
			);
		}
		return this.#views.get(service.name) as T;
	}
	async ready(context: Context = BACKGROUND_CONTEXT): Promise<void> {
		context.abortSignal?.throwIfAborted();
		await awaitWithContext(
			Promise.all([...this.#handles.values()].map((handle) => handle.ready).concat(this.#hydrations)).then(() => {}),
			context,
		);
		context.abortSignal?.throwIfAborted();
	}
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const stop of this.#subscriptions) stop();
		for (const handle of this.#handles.values()) handle.release();
		this.#handles.clear();
		this.#views.clear();
	}
}

/** Host composition for application services; Chord owns calls, state, reload and resource cleanup. */
export class ServiceHost {
	readonly host: Host;
	readonly scope: ServiceScope;
	constructor(name = "services", host?: Host) {
		this.host = host ?? createHost({ name });
		this.scope = new ServiceScope(this.host);
	}
	get catalogue(): readonly ServiceDescription[] {
		return [...this.host.registry(ServiceDescriptions).table().values()];
	}
	get<T>(service: ApplicationService<T>): T {
		return this.scope.get(service);
	}
	provide<T>(service: ApplicationService<T>, value: T): void {
		serveService(this.host, service, { open: () => ({ value }) });
	}
	ready(): Promise<void> {
		return this.host.ready();
	}
	async dispose(): Promise<void> {
		this.scope.dispose();
		await this.host.close();
	}
}

export function serviceFacet<T>(
	name: string,
	service: ApplicationService<T>,
	dependencies: readonly ApplicationService[],
	open: (services: ServiceResolver, signal: AbortSignal) => ServiceInstance<T> | Promise<ServiceInstance<T>>,
): Facet {
	return {
		name,
		uses: dependencies.map((service) => service.contract),
		setup(api) {
			serveService(api, service, { dependencies, open });
		},
	};
}

export async function disposeResources(resources: readonly (() => void | Promise<void>)[]): Promise<void> {
	const errors: unknown[] = [];
	for (const close of [...resources].reverse()) {
		try {
			await close();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length) throw new AggregateError(errors, "Application resource cleanup failed");
}

export type ServiceValue<S> = S extends ApplicationService<infer T> ? T : never;

/** Several product surfaces sharing one resource lifecycle, such as a session's control and native runtime. */
export function serviceSetFacet(
	name: string,
	provided: readonly ApplicationService[],
	dependencies: readonly ApplicationService[],
	open: (
		services: ServiceResolver,
		signal: AbortSignal,
	) => Promise<ServiceInstance<ReadonlyMap<ApplicationService, unknown>>>,
): Facet {
	const aggregate = localService<ReadonlyMap<ApplicationService, unknown>>(`${name}.surfaces`);
	return {
		name,
		uses: dependencies.map((service) => service.contract),
		setup(api) {
			serveService(api, aggregate, { dependencies, descriptions: provided, open });
			for (const service of provided)
				serveBorrowed(api, service, aggregate.contract, (value) => {
					const values = value as ReadonlyMap<ApplicationService, unknown>;
					const found = [...values].find(([key]) => key.name === service.name);
					if (!found) throw new Error(`Missing product surface ${service.name}`);
					return found[1];
				});
		},
	};
}
