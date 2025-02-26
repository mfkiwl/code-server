import { field, Logger, logger } from "@coder/logger"
import * as cp from "child_process"
import { promises as fs } from "fs"
import * as path from "path"
import { Page } from "playwright"
import * as util from "util"
import { logError, plural } from "../../../src/common/util"
import { onLine } from "../../../src/node/util"
import { PASSWORD, workspaceDir } from "../../utils/constants"
import { idleTimer, tmpdir } from "../../utils/helpers"

interface CodeServerProcess {
  process: cp.ChildProcess
  address: string
}

class Context {
  private _canceled = false
  private _done = false
  public canceled(): boolean {
    return this._canceled
  }
  public finished(): boolean {
    return this._done
  }
  public cancel(): void {
    this._canceled = true
  }
  public finish(): void {
    this._done = true
  }
}

/**
 * Class for spawning and managing code-server.
 */
export class CodeServer {
  private process: Promise<CodeServerProcess> | undefined
  public readonly logger: Logger
  private closed = false

  constructor(
    name: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private _workspaceDir: Promise<string> | string | undefined,
    private readonly entry = process.env.CODE_SERVER_TEST_ENTRY || ".",
  ) {
    this.logger = logger.named(name)
  }

  /**
   * The address at which code-server can be accessed. Spawns code-server if it
   * has not yet been spawned.
   */
  async address(): Promise<string> {
    if (!this.process) {
      this.process = this.spawn()
    }
    const { address } = await this.process
    return address
  }

  /**
   * The workspace directory code-server opens with.
   */
  get workspaceDir(): Promise<string> | string {
    if (!this._workspaceDir) {
      this._workspaceDir = tmpdir(workspaceDir)
    }
    return this._workspaceDir
  }

  /**
   * Create a random workspace and seed it with settings.
   */
  private async createWorkspace(): Promise<string> {
    const dir = await this.workspaceDir
    await fs.mkdir(path.join(dir, "User"), { recursive: true })
    await fs.writeFile(
      path.join(dir, "User/settings.json"),
      JSON.stringify({
        "workbench.startupEditor": "none",
      }),
      "utf8",
    )
    return dir
  }

  /**
   * Spawn a new code-server process with its own workspace and data
   * directories.
   */
  private async spawn(): Promise<CodeServerProcess> {
    // This will be used both as the workspace and data directory to ensure
    // instances don't bleed into each other.
    const dir = await this.createWorkspace()

    return new Promise((resolve, reject) => {
      const args = [
        this.entry,
        "--extensions-dir",
        path.join(dir, "extensions"),
        ...this.args,
        // Using port zero will spawn on a random port.
        "--bind-addr",
        "127.0.0.1:0",
        // Setting the XDG variables would be easier and more thorough but the
        // modules we import ignores those variables for non-Linux operating
        // systems so use these flags instead.
        "--config",
        path.join(dir, "config.yaml"),
        "--user-data-dir",
        dir,
        // The last argument is the workspace to open.
        dir,
      ]
      this.logger.debug("spawning `node " + args.join(" ") + "`")
      const proc = cp.spawn("node", args, {
        cwd: path.join(__dirname, "../../.."),
        env: {
          ...process.env,
          ...this.env,
          PASSWORD,
        },
      })

      const timer = idleTimer("Failed to extract address; did the format change?", reject)

      proc.on("error", (error) => {
        this.logger.error(error.message)
        timer.dispose()
        reject(error)
      })

      proc.on("close", (code) => {
        const error = new Error("code-server closed unexpectedly. Try running with LOG_LEVEL=debug to see more info.")
        if (!this.closed) {
          this.logger.error(error.message, field("code", code))
        }
        timer.dispose()
        reject(error)
      })

      let resolved = false
      proc.stdout.setEncoding("utf8")
      onLine(proc, (line) => {
        // As long as we are actively getting input reset the timer.  If we stop
        // getting input and still have not found the address the timer will
        // reject.
        timer.reset()

        // Log the line without the timestamp.
        this.logger.debug(line.replace(/\[.+\]/, ""))
        if (resolved) {
          return
        }
        const match = line.trim().match(/HTTPS? server listening on (https?:\/\/[.:\d]+)\/?$/)
        if (match) {
          // Cookies don't seem to work on IP address so swap to localhost.
          // TODO: Investigate whether this is a bug with code-server.
          const address = match[1].replace("127.0.0.1", "localhost")
          this.logger.debug(`spawned on ${address}`)
          resolved = true
          timer.dispose()
          resolve({ process: proc, address })
        }
      })
    })
  }

  /**
   * Close the code-server process.
   */
  async close(): Promise<void> {
    logger.debug("closing")
    if (this.process) {
      const proc = (await this.process).process
      this.closed = true // To prevent the close handler from erroring.
      proc.kill()
    }
  }
}

/**
 * This is a "Page Object Model" (https://playwright.dev/docs/pom/) meant to
 * wrap over a page and represent actions on that page in a more readable way.
 * This targets a specific code-server instance which must be passed in.
 * Navigation and setup performed by this model will cause the code-server
 * process to spawn if it hasn't yet.
 */
export class CodeServerPage {
  private readonly editorSelector = "div.monaco-workbench"

  constructor(
    private readonly codeServer: CodeServer,
    public readonly page: Page,
    private readonly authenticated: boolean,
  ) {
    this.page.on("console", (message) => {
      this.codeServer.logger.debug(message.text())
    })
    this.page.on("pageerror", (error) => {
      logError(this.codeServer.logger, "page", error)
    })
  }

  address() {
    return this.codeServer.address()
  }

  /**
   * The workspace directory code-server opens with.
   */
  get workspaceDir() {
    return this.codeServer.workspaceDir
  }

  /**
   * Navigate to a code-server endpoint (root by default).  Then wait for the
   * editor to become available.
   */
  async navigate(endpoint = "/") {
    const to = new URL(endpoint, await this.codeServer.address())
    await this.page.goto(to.toString(), { waitUntil: "networkidle" })

    // Only reload editor if authenticated. Otherwise we'll get stuck
    // reloading the login page.
    if (this.authenticated) {
      await this.reloadUntilEditorIsReady()
    }
  }

  /**
   * Checks if the editor is visible
   * and that we are connected to the host
   *
   * Reload until both checks pass
   */
  async reloadUntilEditorIsReady() {
    this.codeServer.logger.debug("Waiting for editor to be ready...")

    const editorIsVisible = await this.isEditorVisible()
    let reloadCount = 0

    // Occassionally code-server timeouts in Firefox
    // we're not sure why
    // but usually a reload or two fixes it
    // TODO@jsjoeio @oxy look into Firefox reconnection/timeout issues
    while (!editorIsVisible) {
      // When a reload happens, we want to wait for all resources to be
      // loaded completely. Hence why we use that instead of DOMContentLoaded
      // Read more: https://thisthat.dev/dom-content-loaded-vs-load/
      await this.page.waitForLoadState("load")
      // Give it an extra second just in case it's feeling extra slow
      await this.page.waitForTimeout(1000)
      reloadCount += 1
      if (await this.isEditorVisible()) {
        this.codeServer.logger.debug(`editor became ready after ${reloadCount} reloads`)
        break
      }
      await this.page.reload()
    }

    this.codeServer.logger.debug("Editor is ready!")
  }

  /**
   * Checks if the editor is visible
   */
  async isEditorVisible() {
    this.codeServer.logger.debug("Waiting for editor to be visible...")
    // Make sure the editor actually loaded
    await this.page.waitForSelector(this.editorSelector)
    const visible = await this.page.isVisible(this.editorSelector)

    this.codeServer.logger.debug(`Editor is ${visible ? "not visible" : "visible"}!`)

    return visible
  }

  /**
   * Focuses Integrated Terminal
   * by using "Terminal: Focus Terminal"
   * from the Command Palette
   *
   * This should focus the terminal no matter
   * if it already has focus and/or is or isn't
   * visible already.
   */
  async focusTerminal() {
    await this.executeCommandViaMenus("Terminal: Focus Terminal")

    // Wait for terminal textarea to show up
    await this.page.waitForSelector("textarea.xterm-helper-textarea")
  }

  /**
   * Open a file by using menus.
   */
  async openFile(file: string) {
    await this.navigateMenus(["File", "Open File"])
    await this.navigateQuickInput([path.basename(file)])
    await this.waitForTab(file)
  }

  /**
   * Wait for a tab to open for the specified file.
   */
  async waitForTab(file: string): Promise<void> {
    await this.page.waitForSelector(`.tab :text("${path.basename(file)}")`)
  }

  /**
   * See if the specified tab is open.
   */
  async tabIsVisible(file: string): Promise<boolean> {
    return this.page.isVisible(`.tab :text("${path.basename(file)}")`)
  }

  /**
   * Navigate to the command palette via menus then execute a command by typing
   * it then clicking the match from the results.
   */
  async executeCommandViaMenus(command: string) {
    await this.navigateMenus(["View", "Command Palette"])

    await this.page.keyboard.type(command)

    await this.page.hover(`text=${command}`)
    await this.page.click(`text=${command}`)
  }

  /**
   * Navigate through the items in the selector.  `open` is a function that will
   * open the menu/popup containing the items through which to navigation.
   */
  async navigateItems(items: string[], selector: string, open?: (selector: string) => void): Promise<void> {
    const logger = this.codeServer.logger.named(selector)

    /**
     * If the selector loses focus or gets removed this will resolve with false,
     * signaling we need to try again.
     */
    const openThenWaitClose = async (ctx: Context) => {
      if (open) {
        await open(selector)
      }
      this.codeServer.logger.debug(`watching ${selector}`)
      try {
        await this.page.waitForSelector(`${selector}:not(:focus-within)`)
      } catch (error) {
        if (!ctx.finished()) {
          this.codeServer.logger.debug(`${selector} navigation: ${(error as any).message || error}`)
        }
      }
      return false
    }

    /**
     * This will step through each item, aborting and returning false if
     * canceled or if any navigation step has an error which signals we need to
     * try again.
     */
    const navigate = async (ctx: Context) => {
      const steps: Array<{ fn: () => Promise<unknown>; name: string }> = [
        {
          fn: () => this.page.waitForSelector(`${selector}:focus-within`),
          name: "focus",
        },
      ]

      for (const item of items) {
        // Normally these will wait for the item to be visible and then execute
        // the action. The problem is that if the menu closes these will still
        // be waiting and continue to execute once the menu is visible again,
        // potentially conflicting with the new set of navigations (for example
        // if the old promise clicks logout before the new one can). By
        // splitting them into two steps each we can cancel before running the
        // action.
        steps.push({
          fn: () => this.page.hover(`${selector} :text("${item}")`, { trial: true }),
          name: `${item}:hover:trial`,
        })
        steps.push({
          fn: () => this.page.hover(`${selector} :text("${item}")`, { force: true }),
          name: `${item}:hover:force`,
        })
        steps.push({
          fn: () => this.page.click(`${selector} :text("${item}")`, { trial: true }),
          name: `${item}:click:trial`,
        })
        steps.push({
          fn: () => this.page.click(`${selector} :text("${item}")`, { force: true }),
          name: `${item}:click:force`,
        })
      }

      for (const step of steps) {
        try {
          logger.debug(`navigation step: ${step.name}`)
          await step.fn()
          if (ctx.canceled()) {
            logger.debug("navigation canceled")
            return false
          }
        } catch (error) {
          logger.debug(`navigation: ${(error as any).message || error}`)
          return false
        }
      }
      return true
    }

    // We are seeing the menu closing after opening if we open it too soon and
    // the picker getting recreated in the middle of trying to select an item.
    // To counter this we will keep trying to navigate through the items every
    // time we lose focus or there is an error.
    let attempts = 1
    let context = new Context()
    while (!(await Promise.race([openThenWaitClose(context), navigate(context)]))) {
      ++attempts
      logger.debug("closed, retrying (${attempt}/∞)")
      context.cancel()
      context = new Context()
    }

    context.finish()
    logger.debug(`navigation took ${attempts} ${plural(attempts, "attempt")}`)
  }

  /**
   * Navigate through a currently opened "quick input" widget, retrying on
   * failure.
   */
  async navigateQuickInput(items: string[]): Promise<void> {
    await this.navigateItems(items, ".quick-input-widget")
  }

  /**
   * Navigate through the menu, retrying on failure.
   */
  async navigateMenus(menus: string[]): Promise<void> {
    await this.navigateItems(menus, '[aria-label="Application Menu"]', async (selector) => {
      await this.page.click(selector)
    })
  }

  /**
   * Execute a command in the root of the instance's workspace directory.
   */
  async exec(command: string): Promise<void> {
    await util.promisify(cp.exec)(command, {
      cwd: await this.workspaceDir,
    })
  }

  /**
   * Install an extension by ID to the instance's temporary extension
   * directory.
   */
  async installExtension(id: string): Promise<void> {
    const dir = path.join(await this.workspaceDir, "extensions")
    await util.promisify(cp.exec)(`node . --install-extension ${id} --extensions-dir ${dir}`, {
      cwd: path.join(__dirname, "../../.."),
    })
  }

  /**
   * Wait for state to be flushed to the database.
   */
  async stateFlush(): Promise<void> {
    // If we reload too quickly VS Code will be unable to save the state changes
    // so wait until those have been written to the database.  It flushes every
    // five seconds so we need to wait at least that long.
    // TODO@asher: There must be a better way.
    await this.page.waitForTimeout(5500)
  }
}
