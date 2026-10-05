import Type, { type Static } from "typebox";
import type { JsonValue } from "./json.ts";

/** Handshakes require exactly this version; there is no negotiation or fallback. */
export const PROTOCOL_VERSION = 2 as const;

export const MAX_ID_LENGTH = 128;
export const MAX_ERROR_MESSAGE_LENGTH = 4096;

const Id = Type.String({ minLength: 1, maxLength: MAX_ID_LENGTH, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" });
const Code = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]*$" });
const Opaque = Type.Unsafe<JsonValue>(Type.Unknown());
const Strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const ErrorBodySchema = Strict({ code: Code, message: Type.String({ maxLength: MAX_ERROR_MESSAGE_LENGTH }) });
export type ErrorBody = Static<typeof ErrorBodySchema>;

/** A call to the logical server itself, such as attachment management. */
const ServerRouteSchema = Strict({ serverId: Id });
/** A call to one registered runtime through the attachment the server issued to this connection. */
const RuntimeRouteSchema = Strict({ serverId: Id, runtimeId: Id, attachmentId: Id });
const RouteSchema = Type.Union([ServerRouteSchema, RuntimeRouteSchema]);
export type ServerRoute = Static<typeof ServerRouteSchema>;
export type RuntimeRoute = Static<typeof RuntimeRouteSchema>;
export type Route = Static<typeof RouteSchema>;

const ClientHelloSchema = Strict({ type: Type.Literal("hello"), version: Type.Integer({ minimum: 0, maximum: 0xffff_ffff }) });
const RequestSchema = Strict({ type: Type.Literal("request"), id: Id, route: RouteSchema, call: Opaque });
const CancelSchema = Strict({ type: Type.Literal("cancel"), id: Id, route: RouteSchema });
export const ClientMessageSchema = Type.Union([ClientHelloSchema, RequestSchema, CancelSchema]);
export type ClientHello = Static<typeof ClientHelloSchema>;
export type RequestEnvelope = Static<typeof RequestSchema>;
export type CancelEnvelope = Static<typeof CancelSchema>;
export type ClientMessage = Static<typeof ClientMessageSchema>;

const ServerHelloSchema = Strict({ type: Type.Literal("hello"), version: Type.Literal(PROTOCOL_VERSION), serverId: Id });
const HelloErrorSchema = Strict({ type: Type.Literal("hello_error"), error: ErrorBodySchema });
const ResponseSchema = Type.Union([
  Strict({ type: Type.Literal("response"), id: Id, ok: Type.Literal(true), result: Type.Optional(Opaque) }),
  Strict({ type: Type.Literal("response"), id: Id, ok: Type.Literal(false), error: ErrorBodySchema }),
]);
const ServiceUpdateSchema = Strict({ type: Type.Literal("service_update"), subscriptionId: Id, update: Opaque });
/** Out-of-band: the runtime route now attached to this connection, or `null` after detach. */
const AttachmentSchema = Strict({ type: Type.Literal("attachment"), attachment: Type.Union([RuntimeRouteSchema, Type.Null()]) });
export const ServerMessageSchema = Type.Union([ServerHelloSchema, HelloErrorSchema, ResponseSchema, ServiceUpdateSchema, AttachmentSchema]);
export type ServerHello = Static<typeof ServerHelloSchema>;
export type HelloError = Static<typeof HelloErrorSchema>;
export type ResponseEnvelope = Static<typeof ResponseSchema>;
export type ServiceUpdateEnvelope = Static<typeof ServiceUpdateSchema>;
export type AttachmentEnvelope = Static<typeof AttachmentSchema>;
export type ServerMessage = Static<typeof ServerMessageSchema>;

export function isRuntimeRoute(route: Route): route is RuntimeRoute {
  return "runtimeId" in route;
}

export function sameRoute(left: Route | null | undefined, right: Route | null | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.serverId !== right.serverId) return false;
  if (!isRuntimeRoute(left) || !isRuntimeRoute(right)) return !isRuntimeRoute(left) && !isRuntimeRoute(right);
  return left.runtimeId === right.runtimeId && left.attachmentId === right.attachmentId;
}

/** Builds a wire error body: lone surrogates become U+FFFD and the message is cut to the wire bound. */
export function errorBody(code: string, text: string): ErrorBody {
  const message = text.replace(/\p{Cs}/gu, "\uFFFD");
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) return { code, message };
  let end = MAX_ERROR_MESSAGE_LENGTH - 1;
  const last = message.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { code, message: `${message.slice(0, end)}…` };
}
