export interface Greeting {
  readonly text: string;
}

export const greeting: Greeting = { text: 'loaded through the transpile hooks' };
