/** An ordered byte stream to one server. The client owns it from creation until it calls `close()`. */
export interface ByteTransport {
  /** Sends bytes in call order. Resolution is backpressure: the client waits before sending more. */
  send(chunk: Uint8Array): Promise<void>;
  /** Releases the stream. Must tolerate repeated calls; no handler is expected afterwards. */
  close(): void;
}

export interface ByteTransportHandlers {
  onData(chunk: Uint8Array): void;
  /** The peer ended the stream. Terminal. */
  onClose(): void;
  /** The stream failed. Terminal. */
  onError(error: Error): void;
}

/** Opens a fresh connection for one `connect()` attempt. Physical addressing belongs to the factory. */
export type ByteTransportFactory = (handlers: ByteTransportHandlers) => ByteTransport | Promise<ByteTransport>;
