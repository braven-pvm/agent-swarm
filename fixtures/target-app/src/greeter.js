import { fileURLToPath } from "node:url";

export function greet(name = "world") {
  return `Hello, ${name}!`;
}

export function greetExcited(name = "world") {
  return `Hello, ${name}!!!`;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const excited = args.includes("--excited");
  const name = args.find((arg) => arg !== "--excited");

  console.log(excited ? greetExcited(name) : greet(name));
}
