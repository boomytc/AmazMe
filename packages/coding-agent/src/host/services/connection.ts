import {
	createHost,
	type Host,
	type Facet,
	type Context,
	type MutableReplicatedState,
	type ReplicatedState,
	type ReplicatedStateDelivery,
	type JsonValue,
	replicatedState,
} from "@amazme/chord";
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from "@amazme/chord/context";
import type { Client } from "@amazme/client";
import type { RpcTarget, SessionTarget } from "@amazme/protocol";
import {
	ServiceScope,
	serviceSetFacet,
	type ApplicationService,
	type ServiceDescription,
} from "@amazme/protocol/services";

export type ServerConnectionState =
	| { status: "connecting"; attempt: number }
	| { status: "connected"; since: string }
	| { status: "disconnected"; since: string; reason: string; retryAt: string | null };

export type SessionAttachmentState =
	| { status: "detached" }
	| { status: "attaching" | "attached" | "degraded"; sessionId: string };

export interface ServerServiceSource extends ServiceSource {
	readonly connection: ReplicatedState<ServerConnectionState>;
	dispose(context: Context): Promise<void>;
}

export interface SessionServiceSource extends ServiceSource {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	/** Wait for the exact current attachment generation to finish hydrating. */
	whenAttached(sessionId: string, context: Context): Promise<void>;
	/** Wait for every binding to finish releasing the previous attachment. */
	whenDetached(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export interface ServiceSourceOptions {
	readonly onError?: (error: Error) => void;
}

export interface RoutedServices {
	get<T>(service: ApplicationService<T>): T;
	ready(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}
interface BindingOptions {
	readonly services: readonly ApplicationService[];
	readonly client: Client;
	readonly target: () => RpcTarget | undefined;
	readonly getBound: () => boolean;
	readonly assertAccess: () => void;
	readonly onError: (error: Error) => void;
	readonly beforeReady?: (context: Context) => Promise<void>;
	readonly onActivate?: (context: Context) => Promise<void>;
	readonly remove: () => void;
}
interface BoundPeer {
	host: Host;
	scope: ServiceScope;
	connection: Awaited<ReturnType<Client["openLink"]>>;
}
interface ServiceSource {
	catalogue(context: Context): Promise<readonly ServiceDescription[]>;
	open(options: Pick<BindingOptions, "services" | "assertAccess" | "onError">): RoutedServices;
}

/** Attachment generations own Chord client hosts; only the current generation may publish into the UI. */
class RoutedServiceBinding implements RoutedServices {
	readonly #options: BindingOptions;
	readonly #views = new Map<string, unknown>();
	readonly #states = new Map<string, MutableReplicatedState<{ generation: number; value?: JsonValue }>>();
	readonly #live = new Map<string, unknown>();
	#peers: BoundPeer[] = [];
	#stops: Array<() => void> = [];
	#controller = new AbortController();
	#revision = 0;
	#activated = false;
	#closed = false;
	#tail = Promise.resolve();
	constructor(options: BindingOptions) {
		this.#options = options;
	}
	get<T>(service: ApplicationService<T>): T {
		if (!this.#options.services.some((entry) => entry.name === service.name))
			throw new Error(`Undeclared service ${service.name}`);
		if (!this.#views.has(service.name)) {
			const view: Record<string, unknown> = {};
			for (const name of service.methods)
				view[name] = (...args: unknown[]) => {
					this.#options.assertAccess();
					if (this.#closed || !this.#options.getBound()) throw new Error("Service attachment is unavailable");
					const value = this.#live.get(service.name) as Record<string, (...args: unknown[]) => unknown> | undefined;
					if (!value) throw new Error(`Service ${service.name} is not ready`);
					return value[name]!(...args);
				};
			for (const name of service.states) {
				const state = replicatedState<{ generation: number; value?: JsonValue }>({ generation: this.#revision });
				this.#states.set(`${service.name}/${name}`, state);
				const binding = this;
				view[name] = {
					get value() {
						return state.value.value;
					},
					subscribe(
						listener: (value: unknown, context: Context, delivery: ReplicatedStateDelivery) => void | Promise<void>,
					) {
						let generation = -1;
						return state.subscribe(async (snapshot, context, delivery) => {
							if (binding.#closed || snapshot.generation !== binding.#revision || snapshot.value === undefined) return;
							const kind = generation === snapshot.generation ? "update" : "hydrate";
							generation = snapshot.generation;
							await listener(snapshot.value, context, { ...delivery, kind });
						});
					},
				};
			}
			this.#views.set(service.name, view);
		}
		return this.#views.get(service.name) as T;
	}
	async ready(context: Context): Promise<void> {
		await this.#options.beforeReady?.(context);
		if (!this.#activated) {
			this.#activated = true;
			await this.updateBound(this.#options.getBound(), context);
		}
		await this.serviceReady(context);
		await this.#options.onActivate?.(context);
	}
	serviceReady(context: Context): Promise<void> {
		return awaitWithContext(this.#tail, context);
	}
	updateBound(bound: boolean, context: Context): Promise<void> {
		if (!this.#activated || this.#closed) return Promise.resolve();
		const revision = ++this.#revision;
		this.#controller.abort(new Error("Attachment replaced"));
		this.#controller = new AbortController();
		const controller = this.#controller;
		const target = bound ? this.#options.target() : undefined;
		this.#live.clear();
		for (const state of this.#states.values()) state.replace(context, { generation: revision });
		const operation = this.#tail
			.catch(() => {})
			.then(async () => {
				await this.#release();
				if (!target || this.#closed || controller.signal.aborted) return;
				const readyContext = withAbortSignal(controller.signal, context);
				try {
					const catalogue = await this.#options.client.describeServices(target, controller.signal);
					const peers = new Map<string, BoundPeer>();
					for (const service of this.#options.services) {
						this.get(service);
						const descriptor = catalogue.find((entry) => entry.serviceId === service.name && !entry.local);
						if (!descriptor) throw new Error(`Unavailable service ${service.name}`);
						const route = descriptor.host ?? "";
						let peer = peers.get(route);
						if (!peer) {
							const connection = await awaitWithContext(
								this.#options.client.openLink(target, descriptor.host, controller.signal).then(async (connection) => {
									if (controller.signal.aborted) {
										await connection.close();
										controller.signal.throwIfAborted();
									}
									return connection;
								}),
								readyContext,
							);
							const host = createHost({ kind: "client", onError: (error) => this.#options.onError(toError(error)) });
							peer = { host, scope: new ServiceScope(host, { at: connection.host }), connection };
							peers.set(route, peer);
							this.#peers.push(peer);
							host.connect(connection.link);
						}
						this.#live.set(service.name, peer.scope.get(service));
					}
					await Promise.all(this.#peers.map((peer) => peer.scope.ready(readyContext)));
					controller.signal.throwIfAborted();
					for (const service of this.#options.services) {
						const value = this.#live.get(service.name) as Record<string, ReplicatedState<JsonValue>>;
						for (const name of service.states) {
							const state = this.#states.get(`${service.name}/${name}`)!;
							this.#stops.push(
								value[name]!.subscribe((value, ctx) => {
									if (revision === this.#revision && !this.#closed) state.replace(ctx, { generation: revision, value });
								}),
							);
						}
					}
				} catch (error) {
					this.#live.clear();
					await this.#release();
					if (!controller.signal.aborted) throw error;
				}
			});
		this.#tail = operation;
		operation.catch(() => {});
		return operation;
	}
	async #release(): Promise<void> {
		for (const stop of this.#stops.splice(0)) stop();
		const results = await Promise.allSettled(
			this.#peers.splice(0).map(async (peer) => {
				peer.scope.dispose();
				try {
					await peer.host.close();
				} finally {
					await peer.connection.close();
				}
			}),
		);
		throwFailures(results, "Service channel cleanup failed");
	}
	async dispose(context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#revision++;
		this.#options.remove();
		this.#controller.abort();
		this.#live.clear();
		for (const state of this.#states.values()) state.replace(context, { generation: this.#revision });
		await this.#tail.catch(() => {});
		await this.#release();
	}
}

class ServerServiceSourceImpl implements ServerServiceSource {
	readonly connection: ReplicatedState<ServerConnectionState>;
	readonly #client: Client;
	readonly #bindings = new Set<RoutedServiceBinding>();
	readonly #removeConnectionListener: () => void;
	readonly #onError: (error: Error) => void;
	#transition = Promise.resolve();
	#connectionAttempt: number;
	#disposed = false;

	constructor(client: Client, options: ServiceSourceOptions) {
		this.#client = client;
		this.#onError = options.onError ?? (() => {});
		this.#connectionAttempt = client.connectionState === "connecting" ? 1 : 0;
		const connectionState = replicatedState<ServerConnectionState>(
			toServerConnectionState(client, this.#connectionAttempt),
		);
		this.connection = connectionState;
		this.#removeConnectionListener = client.onConnectionStateChange(({ state, error }) => {
			if (state === "connecting") this.#connectionAttempt += 1;
			publishReplacement(
				connectionState,
				toServerConnectionState(client, this.#connectionAttempt, error),
				BACKGROUND_CONTEXT,
			);
			this.#transition = this.#transition
				.then(async () => {
					const results = await Promise.allSettled(
						[...this.#bindings].map((binding) => binding.updateBound(state === "connected", BACKGROUND_CONTEXT)),
					);
					const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
					if (failures.length > 0) throw new AggregateError(failures.map(({ reason }) => reason));
				})
				.catch((transitionError: unknown) => this.#onError(toError(transitionError)));
		});
	}

	catalogue(context: Context) {
		return this.#client.describeServices({ serverId: this.#client.serverId }, context.abortSignal);
	}

	open(options: {
		readonly services: readonly ApplicationService[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RoutedServices {
		if (this.#disposed) throw new Error("Server service source is disposed");
		let binding!: RoutedServiceBinding;
		binding = new RoutedServiceBinding({
			services: options.services,
			client: this.#client,
			target: () => ({ serverId: this.#client.serverId }),
			getBound: () => this.#client.connected,
			assertAccess: options.assertAccess,
			onError: options.onError,
			beforeReady: async (context) => {
				// Include source transitions that have not reached the binding yet.
				let transition: Promise<void>;
				do {
					transition = this.#transition;
					await awaitWithContext(transition, context);
				} while (transition !== this.#transition);
			},
			remove: () => this.#bindings.delete(binding),
		});
		this.#bindings.add(binding);
		return binding;
	}

	async dispose(context: Context): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeConnectionListener();
		await this.#transition;
		const bindings = [...this.#bindings];
		this.#bindings.clear();
		const results = await Promise.allSettled(bindings.map((binding) => binding.dispose(context)));
		throwFailures(results, "Failed to dispose server service source");
	}
}

class SessionServiceSourceImpl implements SessionServiceSource {
	readonly attachment: ReplicatedState<SessionAttachmentState>;
	readonly #client: Client;
	readonly #attachmentState: MutableReplicatedState<SessionAttachmentState>;
	readonly #bindings = new Set<RoutedServiceBinding>();
	readonly #removeAttachmentListener: () => void;
	readonly #onError: (error: Error) => void;
	readonly #transitions = new Set<Promise<void>>();
	#catalogue: readonly ServiceDescription[] | undefined;
	#attachmentRevision = 0;
	#disposed = false;


	constructor(client: Client, options: ServiceSourceOptions) {
		this.#client = client;
		this.#onError = options.onError ?? (() => {});
		this.#attachmentState = replicatedState<SessionAttachmentState>(
			client.attachment === undefined
				? { status: "detached" }
				: { status: "attaching", sessionId: client.attachment.sessionId },
		);
		this.attachment = this.#attachmentState;
		this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
			const revision = ++this.#attachmentRevision;
			if (attachment !== undefined) {
				publishReplacement(
					this.#attachmentState,
					{ status: "attaching", sessionId: attachment.sessionId },
					BACKGROUND_CONTEXT,
				);
				void this.#client.describeServices(attachment).then(
					(catalogue) => {
						if (this.#attachmentRevision === revision && sameAttachment(this.#client.attachment, attachment)) {
							this.#catalogue = catalogue;
						}
					},
					(error: unknown) => this.#onError(toError(error)),
				);
			}
			const transition = this.#rebind(attachment !== undefined, BACKGROUND_CONTEXT);
			this.#transitions.add(transition);
			void transition.then(
				() => {
					this.#transitions.delete(transition);
					if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment)) return;
					publishReplacement(
						this.#attachmentState,
						attachment === undefined ? { status: "detached" } : { status: "attached", sessionId: attachment.sessionId },
						BACKGROUND_CONTEXT,
					);
				},
				(error: unknown) => {
					this.#transitions.delete(transition);
					if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment)) return;
					publishReplacement(
						this.#attachmentState,
						attachment === undefined ? { status: "detached" } : { status: "degraded", sessionId: attachment.sessionId },
						BACKGROUND_CONTEXT,
					);
					this.#onError(toError(error));
				},
			);
		});
	}

	async catalogue(context: Context): Promise<readonly ServiceDescription[]> {
		const target = this.#client.attachment;
		if (target === undefined) return this.#catalogue ?? [];
		const catalogue = await this.#client.describeServices(target, context.abortSignal);
		this.#catalogue = catalogue;
		return catalogue;
	}

	open(options: {
		readonly services: readonly ApplicationService[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RoutedServices {
		if (this.#disposed) throw new Error("Session service source is disposed");
		let binding!: RoutedServiceBinding;
		binding = new RoutedServiceBinding({
			services: options.services,
			client: this.#client,
			target: () => this.#client.attachment,
			getBound: () => this.#client.attachment !== undefined,
			onActivate: async (context) => {
				const attachment = this.#client.attachment;
				if (attachment === undefined) await this.#whenDetached(this.#attachmentRevision, context);
				else await this.#whenAttached(attachment, this.#attachmentRevision, context);
			},
			assertAccess: options.assertAccess,
			onError: options.onError,
			remove: () => this.#bindings.delete(binding),
		});
		this.#bindings.add(binding);
		return binding;
	}

	async whenAttached(sessionId: string, context: Context): Promise<void> {
		const attachment = this.#client.attachment;
		if (attachment === undefined || attachment.sessionId !== sessionId) {
			throw new Error(`Session ${sessionId} is not the current attachment`);
		}
		await this.#whenAttached(attachment, this.#attachmentRevision, context);
	}

	async whenDetached(context: Context): Promise<void> {
		if (this.#client.attachment !== undefined) throw new Error("A Session is still attached");
		await this.#whenDetached(this.#attachmentRevision, context);
	}

	async dispose(context: Context): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeAttachmentListener();
		await Promise.allSettled(this.#transitions);
		const bindings = [...this.#bindings];
		this.#bindings.clear();
		const results = await Promise.allSettled(bindings.map((binding) => binding.dispose(context)));
		throwFailures(results, "Failed to dispose Session service source");
	}

	async #rebind(bound: boolean, context: Context): Promise<void> {
		const results = await Promise.allSettled([...this.#bindings].map((binding) => binding.updateBound(bound, context)));
		throwFailures(results, "Failed to rebind Session services");
	}

	async #whenAttached(attachment: SessionTarget, revision: number, context: Context): Promise<void> {
		try {
			await Promise.all([...this.#bindings].map((binding) => binding.serviceReady(context)));
		} catch (error) {
			if (this.#attachmentRevision === revision && sameAttachment(this.#client.attachment, attachment)) {
				publishReplacement(this.#attachmentState, { status: "degraded", sessionId: attachment.sessionId }, context);
			}
			throw error;
		}
		if (this.#attachmentRevision !== revision || !sameAttachment(this.#client.attachment, attachment)) {
			throw new Error(`Session ${attachment.sessionId} was replaced while attaching`);
		}
		const state = this.#attachmentState.value;
		if (state.status !== "attached" || state.sessionId !== attachment.sessionId) {
			publishReplacement(this.#attachmentState, { status: "attached", sessionId: attachment.sessionId }, context);
		}
	}

	async #whenDetached(revision: number, context: Context): Promise<void> {
		await Promise.all([...this.#bindings].map((binding) => binding.serviceReady(context)));
		if (this.#attachmentRevision !== revision || this.#client.attachment !== undefined) {
			throw new Error("The Session attachment changed while detaching");
		}
		if (this.#attachmentState.value.status !== "detached") {
			publishReplacement(this.#attachmentState, { status: "detached" }, context);
		}
	}
}

/** Create the server-scoped remote service source for one presentation client. */
export function createServerServiceSource(client: Client, options: ServiceSourceOptions = {}): ServerServiceSource {
	return new ServerServiceSourceImpl(client, options);
}

/** Create the selected-Session remote service source for one presentation client. */
export function createSessionServiceSource(client: Client, options: ServiceSourceOptions = {}): SessionServiceSource {
	return new SessionServiceSourceImpl(client, options);
}

function publishReplacement<T extends object>(state: MutableReplicatedState<T>, value: T, context: Context): void {
	state.replace(context, value);
}

function toServerConnectionState(client: Client, attempt: number, error?: Error): ServerConnectionState {
	const since = new Date().toISOString();
	switch (client.connectionState) {
		case "connecting":
			return { status: "connecting", attempt };
		case "connected":
			return { status: "connected", since };
		case "disconnected":
			return {
				status: "disconnected",
				since,
				reason: error?.message ?? "Client is disconnected",
				retryAt: null,
			};
	}
}

function sameAttachment(left: SessionTarget | undefined, right: SessionTarget | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.serverId === right.serverId && left.sessionId === right.sessionId && left.attachmentId === right.attachmentId
	);
}

function throwFailures(results: readonly PromiseSettledResult<unknown>[], message: string): void {
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Project only declared remote dependencies into a native presentation host. */
export async function sourceFacets(facets: readonly Facet[], sources: readonly ServiceSource[]): Promise<Facet[]> {
	const contracts = new Map(
		facets.flatMap((facet) =>
			(facet.uses ?? [])
				.filter((contract) => contract.scope === "remote")
				.map((contract) => [contract.name, contract] as const),
		),
	);
	const remaining = new Set(contracts.keys());
	const result: Facet[] = [];
	for (const [index, source] of sources.entries()) {
		const catalogue = await source.catalogue(BACKGROUND_CONTEXT);
		const services: ApplicationService[] = [];
		for (const descriptor of catalogue) {
			const contract = contracts.get(descriptor.serviceId);
			if (!contract || descriptor.local) continue;
			if (!remaining.delete(contract.name)) throw new Error(`Ambiguous service ${contract.name}`);
			const members = Object.assign({}, ...Object.values(contract.description.variants)) as Record<
				string,
				{ kind: string }
			>;
			services.push({
				name: contract.name,
				contract,
				methods: Object.keys(members).filter((key) => members[key]!.kind === "method"),
				states: Object.keys(members).filter((key) => members[key]!.kind === "state"),
			});
		}
		if (!services.length) continue;
		result.push(
			serviceSetFacet(`presentation-source-${index}`, services, [], async () => {
				const binding = source.open({
					services,
					assertAccess() {},
					onError(error) {
						console.error(error);
					},
				});
				try {
					await binding.ready(BACKGROUND_CONTEXT);
					return {
						value: new Map(services.map((service) => [service, binding.get(service)])),
						close: () => binding.dispose(BACKGROUND_CONTEXT),
					};
				} catch (error) {
					await binding.dispose(BACKGROUND_CONTEXT);
					throw error;
				}
			}),
		);
	}
	return result;
}
