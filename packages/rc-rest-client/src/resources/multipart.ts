/**
 * A `multipart/form-data` body written by hand, so the file inside it can be a
 * stream.
 *
 * `FormData` cannot carry one: every part has to be a string or a `Blob`, and a
 * `Blob` is bytes already in memory. That is the whole reason this exists — an
 * upload passing through has no business being buffered in full first, and
 * holding it means the client sending it learns nothing about how the far half
 * of its journey is going.
 */

const CRLF = '\r\n';
const encoder = new TextEncoder();

export interface MultipartFile {
  field: string;
  filename: string;
  contentType: string;
  content: Uint8Array | AsyncIterable<Uint8Array>;
}

export interface EncodedMultipart {
  /** Includes the boundary, so it must be sent as-is. */
  contentType: string;
  body: AsyncIterable<Uint8Array>;
}

/**
 * A boundary the body cannot contain by accident.
 *
 * `randomUUID` rather than a counter: a boundary that appeared inside the file
 * would truncate the upload at that point, and a value derived from anything
 * predictable is a value an uploaded file can be built to contain.
 */
const newBoundary = (): string => `----openRocketChat${crypto.randomUUID().replace(/-/g, '')}`;

/**
 * Rocket.Chat parses these with busboy, which reads from the socket and never
 * asks how long the body is — so a streamed part needs no `Content-Length` and
 * goes up chunked. Verified against both a self-hosted server and one behind a
 * CDN, since a proxy refusing chunked request bodies would break every upload.
 *
 * Fields are written before the file. They are short, and putting them first
 * means the server has them in hand before it starts spooling however many
 * megabytes follow.
 */
export const encodeMultipart = (
  file: MultipartFile | undefined,
  fields: Record<string, string> = {},
): EncodedMultipart => {
  const boundary = newBoundary();

  const body = (async function* () {
    for (const [name, value] of Object.entries(fields)) {
      yield encoder.encode(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${escapeQuotes(name)}"${CRLF}${CRLF}${value}${CRLF}`,
      );
    }

    if (file) {
      yield encoder.encode(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${escapeQuotes(file.field)}"; filename="${escapeQuotes(file.filename)}"${CRLF}` +
          `Content-Type: ${file.contentType}${CRLF}${CRLF}`,
      );

      if (file.content instanceof Uint8Array) {
        yield file.content;
      } else {
        yield* file.content;
      }

      yield encoder.encode(CRLF);
    }

    yield encoder.encode(`--${boundary}--${CRLF}`);
  })();

  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
};

/**
 * Filenames are user-supplied and reach here verbatim. A quote in one would
 * close the `filename="…"` parameter early and let the rest be read as further
 * parameters — so quotes and the line breaks that would end the header
 * outright are escaped rather than passed on.
 */
const escapeQuotes = (value: string): string => value.replace(/["\\]/g, '\\$&').replace(/[\r\n]/g, ' ');
