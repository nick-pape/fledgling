export function createRequire(): () => never {
  return () => {
    throw new Error("Node require is not available in the browser demo host.");
  };
}
