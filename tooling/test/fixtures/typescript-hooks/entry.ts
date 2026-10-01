import { type Greeting, greeting } from './greeting.js';

const announce = (value: Greeting): void => {
  process.stdout.write(value.text);
};

announce(greeting);
