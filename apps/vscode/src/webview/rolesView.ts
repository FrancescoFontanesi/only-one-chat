import type * as vscode from 'vscode';
import { isFake } from '../clis.js';
import type { RoleSettings, Roles } from '../roles.js';
import type { ModelCatalog } from '../session/catalog.js';
import { SidebarView } from './sidebarView.js';
import type { WebviewToHostMessage } from './protocol.js';

/** The roles of the chat shown, if its agents have started, and when they change. */
export interface ChatRoles {
  current(): Roles | null;
  readonly onDidChange: vscode.Event<void>;
}

/**
 * The roles view (ADR 0012): for each role the CLI and model, from the models
 * the CLIs offer, grouped by provider; the reasoning the model supports; the
 * permission level.
 */
export class RolesViewProvider extends SidebarView {
  static readonly viewType = 'onlyOneChat.roles';

  constructor(
    context: vscode.ExtensionContext,
    private readonly roles: RoleSettings,
    private readonly catalog: ModelCatalog,
    private readonly chat: ChatRoles,
  ) {
    super(context, 'roles', 'Ruoli');
    this.own(
      roles.onDidChange(() => {
        this.show();
      }),
      chat.onDidChange(() => {
        this.show();
      }),
    );
  }

  protected async onMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.show();
        await this.catalog.load();
        break;
      case 'refreshModels':
        await this.catalog.load(true);
        break;
      case 'setRole': {
        const { role, cli, model, effort, permission } = message;
        if (!(await this.roles.choose(role, { cli, model, effort, permission }))) this.show();
        break;
      }
      default:
        break;
    }
  }

  private show(): void {
    this.post({
      type: 'roles',
      roles: this.roles.state(this.chat.current(), isFake(this.context)),
    });
  }
}
