// The header above a thread terminal's overlay, styled like Herdr's peek bar: the request
// title and its agent, ✓ to resolve (as /resolve does; the agent may reopen it), ↗ to
// keep the thread as a tab, ✕ to hide it (the thread keeps running).
// Props: { mod, node, request, title, agent, terminal, overlay }.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { closeOverlay, props, run, setShared, shared, theme } from "herdr";
import { InboxClient } from "./inbox-client.js";

export const HEARTBEAT = 3000;

export class ThreadBarController {
  // This bar exists exactly while its dialog is open, however the dialog closes (✕, Esc,
  // a click beside it), so its heartbeat tells the sidebar which threads are on screen.
  init(_props, cx) {
    this.client = new InboxClient(props() ?? {});
    this.beat();
    cx.timer.every(HEARTBEAT, () => this.beat());
  }

  beat() {
    const { mod, request } = props() ?? {};
    const key = `${mod}.visible`;
    const now = Date.now();
    const fresh = Object.fromEntries(Object.entries(shared(key) ?? {}).filter(([, at]) => now - at < 3 * HEARTBEAT));
    setShared(key, { ...fresh, [request]: now });
  }

  // Closes the overlay directly (as Herdr's peek bar does), then tells the sidebar so it
  // stops treating the thread as on screen.
  hide() {
    const { mod, request, overlay } = props() ?? {};
    closeOverlay(overlay);
    try {
      run(`${mod}.hide-${request}`, {});
    } catch {}
  }

  // The thread terminal ends when the store says resolved; failures show here.
  suggestResolve(cx) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await this.client.suggestResolve(props()?.request);
        if (result.delivery !== "submitted") this.error = result.error?.message ?? "Not delivered.";
      } catch (error) {
        this.error = error.message;
      }
      this.busy = false;
      cx.notify();
    });
  }

  button(t, id, label, tooltip, onClick) {
    return div()
      .id(id)
      .px(8)
      .py(2)
      .rounded(5)
      .text_color(t.muted)
      .cursor_pointer()
      .tooltip(tooltip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick)
      .child(label);
  }

  render() {
    const t = theme();
    const { title, agent, terminal } = props() ?? {};
    return h_flex()
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(title || "Request"))
      .when(Boolean(agent), (el) => el.child(div().flex_none().truncate().text_color(t.dim).child(`from ${agent}`)))
      .child(div().flex_1())
      .when(Boolean(this.error), (el) => el.child(div().min_w(0).truncate().text_color(t.blocked).child(this.error)))
      .child(this.button(t, "resolve", this.busy ? "✓ sending…" : "✓ resolve", "Resolve (/resolve); the agent can reopen it", (_event, cx) => this.suggestResolve(cx)))
      .child(this.button(t, "keep", "↗ keep", "Keep as a tab", () => {
        run("terminal.keep", { terminal });
        this.hide();
      }))
      .child(this.button(t, "close", "✕", "Hide (Esc)", () => this.hide()));
  }
}
