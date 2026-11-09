/**
 * Node half of the plugin: registers the `ui-notification` Cordis id. The
 * client half is self-contained (slots.inject + ctx.reflect.provide), so the
 * Node face exists only to satisfy the Loader's plugin-id contract and let
 * Host reflection name this package.
 */

export const name = 'ui-notification'

/** @param ctx - client root context. */
export function apply(ctx: Context): void {
  /* No host-side behavior: the client index provides ctx.progressNotice and
     registers the shell.overlay entry. */
  void ctx
}
