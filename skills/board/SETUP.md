# Trace CLI setup

Install Trace as a Claude Code plugin. First add this repo as a marketplace:

```sh
/plugin marketplace add arielbk/trace-v2
```

Then, as a separate command, install the plugin:

```sh
/plugin install trace@trace-v2
```

When installed, the Trace skills invoke the bundled CLI from the plugin root;
no global `trace` command is required and hook registration is declared by the
plugin.

For local debugging without a global link, invoke the CLI entry point directly,
for example:

```sh
node apps/cli/src/trace.ts serve
```
