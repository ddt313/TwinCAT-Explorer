// re2js, a JavaScript port of RE2: regular expressions that run in linear time, whatever the pattern, for those a
// user types in a search (search.ts). JavaScript's own can backtrack for minutes on a pattern such as
// `(\w+\s*)*END_VAR`, and would hold up the extension host meanwhile.
// The .vsix has no node_modules: after tsc, scripts/build-vendor.js replaces this module in out/src by itself bundled
// with re2js. The browser build and the MCP server bundle re2js with the rest.

export { RE2JS } from 're2js';
