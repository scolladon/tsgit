// git's sq_quote_buf
export const sqQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
