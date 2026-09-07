export async function readArchiveBody(body: ReadableStream): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("Article exceeds 4 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new Error("Empty archive content");
  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

