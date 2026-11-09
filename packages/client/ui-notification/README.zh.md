# @deepseek-ai/dsh-client-ui-notification

English | [中文](README.zh.md)

## Summary

`shell.overlay` 点覆盖层中的简短进度与提醒公告：无论当前哪个 Session 在前台，都会显示一行横幅，3 秒后自动消失，重复相同内容会重新渲染。

## Use this package

在 Web profile 的 `cordis.patch.yml` 中注册：

```yaml
- id: ui-notification
  name: "@deepseek-ai/dsh-client-ui-notification"
```

随后通过 `ctx.progressNotice.report('...')` 发布公告，或由 Host 绑定 `progressNotice` Cordis 服务。覆盖层条目 id 为 `notification.progress`，渲染自 `ui-primitives` 的 `Toast`，按报告序列号键控。

## Model Experience

未发布时无成本。发布的文本会被记录并在随后的对话请求中重新发送，直至压缩，与其他帧表面内容一致。
