import { View } from "gpui-kit";
import { props } from "herdr";
import { AgentsController } from "./agents-view.js";
import { ThreadBarController } from "./thread-bar.js";

// Threads run in their own terminals (bin/super-agent.mjs thread); the mod draws the sidebar
// and the header bar above a shown thread.
export default class SuperAgent extends View {
  init(currentProps, cx) {
    this.controller = props()?.role === "thread-bar" ? new ThreadBarController() : new AgentsController();
    this.controller.init(currentProps, cx);
  }

  render(cx) {
    return this.controller.render(cx);
  }
}
