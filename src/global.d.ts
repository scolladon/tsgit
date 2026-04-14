/* eslint-disable no-var -- global type augmentation requires var */
declare var TextEncoder: {
  new (): {
    encode(input: string): Uint8Array;
  };
};

declare var TextDecoder: {
  new (): {
    decode(input?: ArrayBufferView | ArrayBuffer): string;
  };
};
