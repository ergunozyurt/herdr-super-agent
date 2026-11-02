// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, machines, panes, focused, spaces, run, settings, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, nextCommand, props, window, layout, notify, playSound, hc } from "herdr";
import { InboxClient } from "./inbox-client.js";
import { HEARTBEAT } from "./thread-bar.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export class AgentsController {
  init(_props, cx) {
    this.options = props() ?? {};
    this.client = new InboxClient(this.options);
    if (this.options.sortMenu || this.options.agentMenu || this.options.enableConfirm || this.options.disableConfirm) {
      this.enabling = false;
      this.disabling = false;
      this.error = null;
      return;
    }
    this.inbox = { revision: 0, requests: [], sessions: [], pendingEnablements: [] };
    this.folded = new Set();
    this.missingSince = new Map();
    // Request id → overlay id, for thread terminals this copy is showing.
    this.shownThreads = new Map();
    this.openingThreads = new Set();
    this.startedAt = Date.now();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    cx.spawn(async (cx) => {
      await this.refresh(cx, true);
      for (;;) {
        await this.client.waitForChange();
        await this.refresh(cx, true);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        // Sent by a thread terminal on Esc: hide it, keep it running.
        if (command.startsWith("hide-")) {
          this.hideThread(command.slice(5));
          continue;
        }
        // A toast's action.
        if (!command.startsWith("open-")) continue;
        const id = command.slice(5);
        const request = this.inbox.requests.find((item) => item.id === id && item.status !== "resolved");
        if (request && this.requestAvailable(request)) await this.showThread(request, cx);
        cx.notify();
      }
    });
    cx.timer.every(5000, (cx) => {
      if (this.error) cx.spawn(async (cx) => this.refresh(cx, true));
      cx.spawn(async (cx) => this.prune(cx));
      cx.notify();
    });
  }

  async refresh(cx, alerts) {
    try {
      const next = await this.client.snapshot();
      const changed = next.revision !== this.inbox.revision;
      let notifications = [];
      if (alerts && changed) notifications = (await this.client.claimNotifications(null)).notifications;
      if (changed) this.inbox = next;
      // A thread on screen is being read: no toast for it, and new messages count as read.
      this.loaded = true;
      notifications = notifications.filter((item) => {
        if (this.onScreen(item.request_id)) return false;
        const request = next.requests.find((candidate) => candidate.id === item.request_id);
        return request && this.requestAvailable(request);
      });
      for (const request of this.inbox.requests) {
        if (request.status === "unread" && this.onScreen(request.id)) await this.client.read(request).catch(() => {});
      }
      for (const item of notifications) {
        notify({
          title: item.title,
          body: item.body,
          level: "warning",
          action: { name: `${this.options.mod}.open-${item.request_id}` },
        });
        if (settings().sounds?.enabled !== false) playSound("blocked");
      }
      this.error = null;
    } catch (error) {
      this.error = error.message;
    }
    cx.notify();
  }

  async prune(cx) {
    if (Date.now() - this.startedAt < 10000 || this.pruning) return;
    await this.endFinishedThreads();
    const requests = this.inbox.requests.filter((request) => request.status !== "resolved");
    if (!requests.length) return;
    const local = machines().find((machine) => machine.name == null);
    if (!local || local.layout !== "ready") {
      this.missingSince.clear();
      return;
    }
    this.pruning = true;
    try {
      const listedTerminals = new Map(terminals().map((terminal) => [terminal.address, terminal]));
      for (const request of requests) {
        if (this.requestAvailable(request, listedTerminals)) {
          this.missingSince.delete(request.id);
          continue;
        }
        const since = this.missingSince.get(request.id) ?? Date.now();
        this.missingSince.set(request.id, since);
        if (Date.now() - since < 10000) continue;
        this.hideThread(request.id);
        const thread = this.threadTerminal(request.id);
        if (thread) await hc(["kill", thread]).catch(() => {});
      }
    } catch (error) {
      this.error = error.message;
      cx.notify();
    } finally {
      this.pruning = false;
    }
  }

  requestAvailable(request, listed = null) {
    const byAddress = listed ?? new Map(terminals().map((terminal) => [terminal.address, terminal]));
    const terminal = byAddress.get(request.origin_terminal);
    const currentApp = terminal?.report?.app ?? terminal?.app ?? terminal?.program?.key ?? null;
    const currentPid = terminal?.foreground?.pid ?? null;
    return Boolean(
      terminal &&
      terminal.state === "live" &&
      terminal.status &&
      currentApp === request.origin_app &&
      currentPid === request.origin_pid
    );
  }

  // The live terminal running a request's thread, if any.
  threadTerminal(requestId) {
    return terminals().find((terminal) => terminal.labels?.["super-agent.request"] === requestId && terminal.state === "live")?.address ?? null;
  }

  // Shows a request's thread terminal in a dialog, starting it first if needed. The terminal
  // outlives the dialog: Esc only hides it, and it ends when the agent resolves the request.
  // The name the sidebar shows for a request's agent.
  agentName(request) {
    const agent = agents().find((item) => item.address === request.origin_terminal);
    return agent?.space_name || agent?.tab_name || agent?.program?.name || request.origin_app;
  }

  async showThread(request, cx) {
    if (!this.requestAvailable(request)) return;
    if (this.openingThreads.has(request.id)) return;
    this.openingThreads.add(request.id);
    try {
      const agent = this.agentName(request);
      let address = this.threadTerminal(request.id);
      // The app's terminal list can lag core by a moment after a thread ends; ask core.
      if (address && !(await this.isLive(address))) address = null;
      if (!address) {
        const result = await hc([
          "run", "--bg", "--json", "--no-parent", "--rm",
          "--name", `sa-${request.id.replace(/^req_/, "").slice(0, 8)}`,
          "--label", `super-agent.request=${request.id}`,
          "--", this.client.node, "--no-warnings=ExperimentalWarning", this.client.cli, "thread", request.id, "--agent-name", agent,
        ]);
        if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not start the thread terminal.");
        address = JSON.parse(result.stdout).address;
        // The app hears about a new terminal shortly after core starts it.
        for (let i = 0; i < 60 && !terminals().some((terminal) => terminal.address === address); i += 1) await cx.sleep(50);
      }
      // Showing it again replaces the dialog rather than stacking a second one.
      this.hideThread(request.id);
      this.shownThreads.set(request.id, openOverlay({
        kind: "dialog",
        key: `super-agent-${request.id}`,
        width: 760,
        height: 0.8,
        layout: {
          type: "column",
          children: [
            {
              type: "block",
              size: { px: 30 },
              content: {
                mod: this.options.mod,
                props: { role: "thread-bar", mod: this.options.mod, node: this.options.node, request: request.id, title: request.title, agent, terminal: address },
              },
            },
            { type: "block", content: { terminal: address } },
          ],
        },
      }));
      if (request.status === "unread") await this.client.read(request).catch(() => {});
      this.error = null;
    } catch (error) {
      this.error = error.message;
    } finally {
      this.openingThreads.delete(request.id);
      cx.notify();
    }
  }

  // Whether a thread's dialog is open: its header bar's heartbeat is recent.
  onScreen(requestId) {
    const at = shared(`${this.options.mod}.visible`)?.[requestId] ?? 0;
    return Date.now() - at < 2 * HEARTBEAT;
  }

  async isLive(address) {
    const result = await hc(["get", address, "--json"]).catch(() => null);
    if (result?.code !== 0) return false;
    try {
      return JSON.parse(result.stdout).state === "live";
    } catch {
      return false;
    }
  }

  hideThread(requestId) {
    const overlay = this.shownThreads.get(requestId);
    this.shownThreads.delete(requestId);
    if (overlay) {
      try { closeOverlay(overlay); } catch {}
    }
  }

  // Ends thread terminals whose request is no longer active (resolved, retired, or gone).
  async endFinishedThreads() {
    if (!this.loaded) return;
    const active = new Set(this.inbox.requests.filter((request) => request.status !== "resolved").map((request) => request.id));
    for (const terminal of terminals()) {
      const requestId = terminal.labels?.["super-agent.request"];
      if (!requestId || terminal.state !== "live" || active.has(requestId)) continue;
      this.hideThread(requestId);
      await hc(["kill", terminal.address]).catch(() => {});
    }
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  agentMenu(t) {
    const item = this.options.agentMenu;
    const label = !item.supported
      ? "Super Agent unavailable"
      : item.enabled
        ? "Disable Super Agent"
        : item.pending
          ? "Send instructions again"
          : "Enable Super Agent";
    return h_flex()
      .id("super-agent-enable")
      .size_full()
      .p(7)
      .gap(9)
      .items_center()
      .bg(t.popover)
      .text_color(!item.supported ? t.muted : t.foreground)
      .when(item.supported, (el) => el
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click(() => {
          closeOverlay(props().overlay);
          openOverlay({
            mod: this.options.mod,
            kind: "dialog",
            modal: true,
            width: 430,
            height: 250,
            props: item.enabled
              ? { ...this.options, agentMenu: null, disableConfirm: { terminal: item.terminal, name: item.name } }
              : { ...this.options, agentMenu: null, enableConfirm: { terminal: item.terminal, name: item.name } },
          });
        }))
      .child(div()
        .size(26)
        .flex_none()
        .rounded(7)
        .border(1)
        .border_color("#2453a6")
        .bg("#c8102e")
        .text_color("#ffd54a")
        .font_bold()
        .flex()
        .items_center()
        .justify_center()
        .child("S"))
      .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(12.5).child(label));
  }

  enableConfirm(t, cx) {
    const target = this.options.enableConfirm;
    const overlay = props().overlay;
    const button = (id, label, primary, action) => div()
      .id(id)
      .h(31)
      .px(13)
      .rounded(7)
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.bg(primary ? t.accent : t.hover))
      .on_click(action)
      .child(label);
    return v_flex()
      .size_full()
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(div().text_size(17).font_semibold().text_color(t.foreground).child(`Enable Super Agent for ${target.name}?`))
      .child(div().text_color(t.muted).child("Super Agent will tell this agent how to open requests. While it is enabled, answer its questions in request threads instead of typing into its terminal."))
      .when(Boolean(this.error), (el) => el.child(div().p(8).rounded(7).bg(t.blocked + "18").text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8)
        .child(button("super-agent-enable-cancel", "Cancel", false, () => closeOverlay(overlay)))
        .child(button("super-agent-enable-confirm", this.enabling ? "Enabling…" : "Enable", true, (_event, buttonCx) => {
          if (this.enabling) return;
          this.enabling = true;
          this.error = null;
          buttonCx.notify();
          buttonCx.spawn(async (buttonCx) => {
            try {
              await this.client.enable(target.terminal);
              closeOverlay(overlay);
            } catch (error) {
              this.error = error.message;
              this.enabling = false;
              buttonCx.notify();
            }
          });
        })));
  }

  disableConfirm(t, cx) {
    const target = this.options.disableConfirm;
    const overlay = props().overlay;
    const button = (id, label, destructive, action) => div()
      .id(id)
      .h(31)
      .px(13)
      .rounded(7)
      .flex()
      .items_center()
      .justify_center()
      .cursor_pointer()
      .bg(destructive ? t.blocked : t.raised)
      .text_color(destructive ? t.background : t.foreground)
      .hover((s) => s.bg(destructive ? "#e5484d" : t.hover))
      .on_click(action)
      .child(label);
    return v_flex()
      .size_full()
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .child(div().text_size(17).font_semibold().text_color(t.foreground).child(`Disable Super Agent for ${target.name}?`))
      .child(div().text_color(t.muted).child("The agent is told to stop using Super Agent first. Its active requests are retired and hidden, and every later Super Agent command is rejected until you enable this session again."))
      .when(Boolean(this.error), (el) => el.child(div().p(8).rounded(7).bg(t.blocked + "18").text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8)
        .child(button("super-agent-disable-cancel", "Cancel", false, () => closeOverlay(overlay)))
        .child(button("super-agent-disable-confirm", this.disabling ? "Disabling…" : "Disable", true, (_event, buttonCx) => {
          if (this.disabling) return;
          this.disabling = true;
          this.error = null;
          buttonCx.notify();
          buttonCx.spawn(async (buttonCx) => {
            try {
              await this.client.disable(target.terminal);
              closeOverlay(overlay);
            } catch (error) {
              this.error = error.message;
              this.disabling = false;
              buttonCx.notify();
            }
          });
        })));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // State is a colored mark, in the agents list's own colors: a filled "needs you" dot for a
  // new message, a "needs you" ring once read, a "working" ring while the agent has the turn.
  requestRow(t, request, branch) {
    const unread = request.status === "unread";
    const waitingHuman = request.status === "waiting-human";
    const color = unread || waitingHuman ? t.blocked : t.working;
    const label = unread ? "New message" : waitingHuman ? "Needs your reply" : "Waiting for the agent";
    return h_flex()
      .id(`request-${request.id}`)
      .pl(39)
      .pr(8)
      .h(29)
      .flex_none()
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .hover((el) => el.bg(t.hover))
      .tooltip(label)
      .on_click((_event, cx) => cx.spawn(async (cx) => this.showThread(request, cx)))
      .child(div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(branch), (el) => el.border_l(1.5).border_color(t.input))
        .when(branch === "└" || branch === "├", (el) => el.border_b(1.5).rounded_bl(6)))
      .child(unread
        ? div().size(8).flex_none().rounded(4).bg(color)
        : div().size(8).flex_none().rounded(4).border(1.5).border_color(color))
      .child(div().flex_1().min_w(0).truncate()
        .when(unread, (el) => el.font_semibold())
        .text_color(unread || waitingHuman ? t.foreground : t.muted)
        .child(request.title));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (this.options.sortMenu) return this.sortMenu(t);
    if (this.options.agentMenu) return this.agentMenu(t);
    if (this.options.enableConfirm) return this.enableConfirm(t, cx);
    if (this.options.disableConfirm) return this.disableConfirm(t, cx);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const currentFocus = focused();
    const shown = currentFocus?.agent;
    const now = Date.now();
    const listedTerminals = new Map(terminals().map((terminal) => [terminal.address, terminal]));
    const activeRequests = this.inbox.requests.filter(
      (request) => request.status !== "resolved" && this.requestAvailable(request, listedTerminals),
    );
    const enabledTerminals = new Set(
      (this.inbox.sessions ?? []).filter((session) => session.enabled).map((session) => session.terminal),
    );
    const pendingTerminals = new Set((this.inbox.pendingEnablements ?? []).map((pending) => pending.terminal));
    const requestsByOrigin = new Map();
    for (const request of activeRequests) {
      const mine = requestsByOrigin.get(request.origin_terminal) ?? [];
      mine.push(request);
      requestsByOrigin.set(request.origin_terminal, mine);
    }
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(
      this.rank(a),
      ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0),
      ...(requestsByOrigin.get(a.address) ?? []).map((request) => request.status === "waiting-agent" ? RANK.idle : RANK.blocked),
    )]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prunePins(all);
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const requests = requestsByOrigin.get(a.address) ?? [];
      const visibleRequests = collapsed ? [] : requests;
      const r = row(a, i, subs, requests);
      if (this.folded.has(a.address)) return [r];
      return [
        r,
        ...visibleRequests.map((request, index) => this.requestRow(t, request, index < visibleRequests.length - 1 || subs.length ? "├" : "└")),
        ...subs.map((s) => this.subRow(t, s, shown, byPriority)),
      ];
    };

    // The fold chevron; folded, the count too, colored by the most urgent child.
    const fold = (a, subs, requests) => {
      const sts = [
        ...subs.map((s) => kidStatus(s.t, this.listed)),
        ...requests.map((request) => request.status === "waiting-agent" ? "idle" : "blocked"),
      ];
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length + requests.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    const tabs = spaces().flatMap(s => s.tabs);
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      return tab ? title(tab, lead(tab)) : a.title || a.program?.name || "";
    };
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = [], requests = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .when(requests.length > 0, (el) => el.child(div().min_w(14).h(16).px(4).rounded(5).bg(t.blocked + "26").text_size(10).text_color(t.blocked).flex().items_center().justify_center().child(String(requests.length))))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      const agentApp = a.report?.app ?? a.app ?? a.program?.key ?? null;
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_mouse_down("right", (_event, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: this.options.mod,
            kind: "popup",
            width: 230,
            height: 50,
            props: {
              ...this.options,
              agentMenu: {
                terminal: a.address,
                name: full && more ? `${name} · ${more}` : name,
                supported: ["pi", "claude-code", "codex"].includes(agentApp),
                enabled: enabledTerminals.has(a.address),
                pending: pendingTerminals.has(a.address),
              },
            },
          });
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length + requests.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(enabledTerminals.has(a.address) || pendingTerminals.has(a.address), (el) => el.child(
          div()
            .h(17)
            .px(5)
            .rounded(5)
            .text_size(9.5)
            .font_semibold()
            .bg(enabledTerminals.has(a.address) ? "#c8102e" : t.raised)
            .when(enabledTerminals.has(a.address), (badge) => badge.border(1).border_color("#2453a6"))
            .text_color(enabledTerminals.has(a.address) ? "#ffd54a" : t.dim)
            .tooltip(enabledTerminals.has(a.address) ? "Super Agent enabled" : "Super Agent is waiting for registration")
            .child(enabledTerminals.has(a.address) ? "S" : "…"),
        ))
        .when(subs.length + requests.length > 0, el => el.child(fold(a, subs, requests)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: this.options.mod, kind: "popup", width: 200, height: 140, props: { ...this.options, sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(Boolean(this.error) && !collapsed, (el) =>
        el.child(div().mx(12).mb(6).p(8).rounded(7).bg(t.blocked + "18").text_size(11).text_color(t.blocked).child(this.error)),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
