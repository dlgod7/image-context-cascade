export interface ParsedDataUri {
  mimeType: string;
  base64: string;
}

export function parseDataUri(uri: string): ParsedDataUri | null {
  const match = uri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1]!, base64: match[2]! };
}

export function imageIdentityInputFromUri(uri: string): string {
  return parseDataUri(uri)?.base64 ?? uri;
}
