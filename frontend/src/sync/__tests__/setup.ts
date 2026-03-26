// Test setup: provide browser globals that don't exist in Bun test env
// @ts-ignore
globalThis.location = { hostname: "test", href: "http://test" };
