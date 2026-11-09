# @deepseek-ai/dsh-client-ui-notification

English | [中文](README.zh.md)

## Summary

Brief, frame-wide progress and attention notices projected into `shell.overlay` — a one-line banner that appears no matter which Session is currently in front. Each notice auto-dismisses after 3 seconds, and a new report bumps the sequence so even an identical message re-renders.

## Use this package

Register it in the web profile's `cordis.patch.yml`:

```yaml
- id: ui-notification
  name: "@deepseek-ai/dsh-client-ui-notification"
```

Then post notices through `ctx.progressNotice.report('...')` from any client plugin, or bind the `progressNotice` Cordis service from the Host. The overlay entry id is `notification.progress`; it renders a `Toast` from `ui-primitives` and is keyed by report sequence.

## Model Experience

No cost when nothing is reported. Reported text is logged and resent in later conversation requests until compaction, like other frame surface content.
