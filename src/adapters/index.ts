// Re-export subpath-specific adapter modules for consumers who prefer `tsgit/adapters`.
// Most consumers should import from the platform-specific subpath
// (`tsgit/adapters/node`, `tsgit/adapters/browser`, `tsgit/adapters/memory`)
// to enable tree-shaking and avoid pulling Node-specific code into browser bundles.
export {};
