import {
  Align,
  Application,
  ApplicationWindow,
  Box,
  Button,
  HeaderBar,
  Label,
  ListBox,
  Orientation,
  ScrolledWindow,
  SelectionMode,
  ToggleButton,
} from "@sigmasd/gtk/gtk4";
import { ActionRow, MessageDialog, ToolbarView } from "@sigmasd/gtk/adw";
import { EventLoop } from "@sigmasd/gtk/eventloop";
import { UnixSignal, unixSignalAdd } from "@sigmasd/gtk/glib";

interface Device {
  name: string;
  id: string;
  eventPath?: string;
  type: string;
}

interface DeviceState extends Device {
  grabbed: boolean;
  process?: Deno.ChildProcess;
  eventPath?: string;
}

let flatpakInstallPath: string | null | undefined = undefined;

async function getFlatpakInstallPath(): Promise<string | null> {
  if (flatpakInstallPath !== undefined) {
    return flatpakInstallPath;
  }

  const flatpakId = Deno.env.get("FLATPAK_ID");
  if (!flatpakId) {
    flatpakInstallPath = null;
    return null;
  }

  try {
    const cmd = new Deno.Command("flatpak-spawn", {
      args: ["--host", "flatpak", "info", "--show-location", flatpakId],
      stdout: "piped",
      stderr: "piped",
    });

    const output = await cmd.output();
    if (output.success) {
      const path = new TextDecoder().decode(output.stdout).trim();
      flatpakInstallPath = `${path}/files`;
      return flatpakInstallPath;
    }
  } catch (error) {
    console.error("Error getting Flatpak install path:", error);
  }

  flatpakInstallPath = null;
  return null;
}

async function listDevices(): Promise<Device[]> {
  try {
    const flatpakPath = await getFlatpakInstallPath();

    let command: string;
    let args: string[];

    if (flatpakPath) {
      command = "flatpak-spawn";
      args = [
        "--host",
        "pkexec",
        `${flatpakPath}/libexec/libinput/libinput-list-devices`,
      ];
    } else {
      command = "pkexec";
      args = ["libinput", "list-devices"];
    }

    const cmd = new Deno.Command(command, {
      args: args,
      stdout: "piped",
      stderr: "piped",
    });

    const process = cmd.spawn();
    const output = await process.output();
    const text = new TextDecoder().decode(output.stdout);

    const devices: Device[] = [];
    let currentDevice: Partial<Device> = {};

    for (const line of text.split("\n")) {
      const trimmed = line.trim();

      if (trimmed.startsWith("Device:")) {
        if (currentDevice.name && currentDevice.id && currentDevice.eventPath) {
          devices.push(currentDevice as Device);
        }
        currentDevice = {
          name: trimmed.replace("Device:", "").trim(),
          type: "Unknown",
        };
      } else if (trimmed.startsWith("Kernel:")) {
        const match = trimmed.match(/Kernel:\s*(.+)/);
        if (match) currentDevice.eventPath = match[1].trim();
      } else if (trimmed.startsWith("Id:")) {
        const match = trimmed.match(/Id:\s*(.+)/);
        if (match) currentDevice.id = match[1].trim();
      } else if (trimmed.startsWith("Capabilities:")) {
        const match = trimmed.match(/Capabilities:\s*(.+)/);
        if (match) currentDevice.type = match[1].trim();
      }
    }

    if (currentDevice.name && currentDevice.id && currentDevice.eventPath) {
      devices.push(currentDevice as Device);
    }

    return devices;
  } catch (error) {
    console.error("Error listing devices:", error);
    return [];
  }
}

function grabDevice(eventPath: string): Deno.ChildProcess | null {
  try {
    const flatpakPath = flatpakInstallPath;

    let command: string;
    let args: string[];

    if (flatpakPath) {
      command = "flatpak-spawn";
      args = [
        "--host",
        "pkexec",
        `${flatpakPath}/bin/evtest`,
        "--grab",
        eventPath,
      ];
    } else {
      command = "pkexec";
      args = ["evtest", "--grab", eventPath];
    }

    console.log("[grabDevice] spawning:", command, args.join(" "));

    const cmd = new Deno.Command(command, {
      args: args,
      stdout: "piped",
      stderr: "piped",
    });

    const proc = cmd.spawn();
    console.log("[grabDevice] spawned pid:", proc.pid);
    return proc;
  } catch (error) {
    console.error("[grabDevice] error:", error);
    return null;
  }
}

async function releaseDevice(
  process: Deno.ChildProcess | undefined,
  eventPath?: string,
) {
  if (process) {
    try {
      const flatpakPath = flatpakInstallPath;

      if (flatpakPath && eventPath) {
        const findCmd = new Deno.Command("flatpak-spawn", {
          args: [
            "--host",
            "pgrep",
            "-f",
            `evtest --grab ${eventPath}`,
          ],
          stdout: "piped",
          stderr: "piped",
        });

        const findOutput = await findCmd.output();
        if (findOutput.success) {
          const pids = new TextDecoder().decode(findOutput.stdout).trim().split(
            "\n",
          ).filter((pid) => pid);
          if (pids.length > 0) {
            const killCmd = new Deno.Command("flatpak-spawn", {
              args: ["--host", "pkexec", "kill", "-TERM", ...pids],
              stdout: "null",
              stderr: "null",
            });
            await killCmd.output();
          }
        }
      } else {
        const cmd = new Deno.Command("pkexec", {
          args: ["kill", "-TERM", process.pid.toString()],
          stdout: "null",
          stderr: "null",
        });
        await cmd.output();
      }
    } catch (e) {
      console.error("Error killing process:", e);
    }
  }
}

export class MainWindow {
  #app: Application;
  #win: ApplicationWindow;
  #listBox: ListBox;
  #devices: Map<string, DeviceState> = new Map();

  constructor(app: Application) {
    this.#app = app;

    this.#win = new ApplicationWindow(app);
    this.#win.setTitle("Input Device Manager");
    this.#win.setDefaultSize(700, 500);
    this.#win.onCloseRequest(() => {
      this.#onCloseRequest();
      return false;
    });

    const headerBar = new HeaderBar();
    const refreshBtn = new Button("↻ Refresh");
    refreshBtn.addCssClass("suggested-action");
    refreshBtn.onClick(() => this.#refreshDevices());
    headerBar.packEnd(refreshBtn);

    const adwBox = new ToolbarView();
    this.#win.setChild(adwBox);
    adwBox.addTopBar(headerBar);

    const mainContent = new Box(Orientation.VERTICAL, 0);
    adwBox.setContent(mainContent);

    const titleBox = new Box(Orientation.VERTICAL, 0);
    titleBox.setMarginTop(24);
    titleBox.setMarginBottom(16);
    titleBox.setMarginStart(24);
    titleBox.setMarginEnd(24);

    const title = new Label();
    title.setMarkup("<b><big>Input Devices</big></b>");
    title.setXalign(0);

    const subtitle = new Label("Manage input device access");
    subtitle.setXalign(0);
    subtitle.setProperty("opacity", 0.65);
    subtitle.setMarginTop(4);

    titleBox.append(title);
    titleBox.append(subtitle);
    mainContent.append(titleBox);

    const scrolled = new ScrolledWindow();
    scrolled.setVexpand(true);
    scrolled.setHexpand(true);

    this.#listBox = new ListBox();
    this.#listBox.addCssClass("boxed-list");
    this.#listBox.setMarginTop(12);
    this.#listBox.setMarginBottom(24);
    this.#listBox.setMarginStart(12);
    this.#listBox.setMarginEnd(12);
    this.#listBox.setSelectionMode(SelectionMode.NONE);

    scrolled.setChild(this.#listBox);
    mainContent.append(scrolled);

    this.#refreshDevices();
  }

  #refreshDevices = async () => {
    this.#listBox.removeAll();

    const devices = await listDevices();

    if (devices.length === 0) {
      const emptyLabel = new Label("No input devices found");
      emptyLabel.setProperty("opacity", 0.5);
      emptyLabel.setMarginTop(24);
      this.#listBox.append(emptyLabel);
      return;
    }

    for (const device of devices) {
      if (!this.#devices.has(device.id)) {
        this.#devices.set(device.id, {
          ...device,
          grabbed: false,
        });
      }

      const state = this.#devices.get(device.id)!;

      const row = new ActionRow();
      row.setTitle(device.name);
      row.setSubtitle(`${device.eventPath} • ${device.type}`);

      const btn = new ToggleButton();
      btn.setActive(state.grabbed);
      btn.setValign(Align.CENTER);
      this.#updateButtonLabel(btn, state.grabbed);
      btn.onToggled(() => {
        this.#toggleDevice(device.id, btn);
      });

      row.addSuffix(btn);
      row.setProperty("activatable", false);

      this.#listBox.append(row);
    }
  };

  #updateButtonLabel(btn: ToggleButton, grabbed: boolean) {
    if (grabbed) {
      btn.setLabel("🔒 Grabbed");
    } else {
      btn.setLabel("🔓 Released");
    }
  }

  #toggleDevice = (
    deviceId: string,
    btn: ToggleButton,
  ) => {
    const state = this.#devices.get(deviceId);
    if (!state) return;

    if (btn.getActive()) {
      const process = grabDevice(state.eventPath!);
      if (process) {
        state.grabbed = true;
        state.process = process;
        this.#updateButtonLabel(btn, true);
        btn.addCssClass("destructive-action");

        const readStderr = async () => {
          const decoder = new TextDecoder();
          let errMsg = "";
          for await (const chunk of process.stderr) {
            errMsg += decoder.decode(chunk);
          }
          return errMsg;
        };

        process.status.then(async (status) => {
          const errMsg = await readStderr();
          if (status.code !== 0 && state.grabbed) {
            const dialog = new MessageDialog(
              this.#win,
              "Failed to grab device",
              errMsg || `evtest exited with code ${status.code}`,
            );
            dialog.addResponse("ok", "OK");
            dialog.present();
            state.grabbed = false;
            state.process = undefined;
            btn.setActive(false);
            this.#updateButtonLabel(btn, false);
            btn.removeCssClass("destructive-action");
          }
        });
      } else {
        const dialog = new MessageDialog(
          this.#win,
          "Failed to grab device",
          "Could not start evtest. Is it installed?",
        );
        dialog.addResponse("ok", "OK");
        dialog.present();
        btn.setActive(false);
      }
    } else {
      releaseDevice(state.process, state.eventPath);
      state.grabbed = false;
      state.process = undefined;
      this.#updateButtonLabel(btn, false);
      btn.removeCssClass("destructive-action");
    }
  };

  #onCloseRequest = async () => {
    for (const [_, state] of this.#devices) {
      await releaseDevice(state.process, state.eventPath);
    }
    eventLoop.stop();
  };

  present() {
    this.#win.present();
  }
}

class App extends Application {
  #win?: MainWindow;

  constructor() {
    super("io.github.sigmasd.hardwaretoggle", 0);
    this.onActivate(() => this.#onActivate());
  }

  #onActivate = () => {
    if (!this.#win) this.#win = new MainWindow(this);
    this.#win.present();
  };
}

const eventLoop = new EventLoop();

if (import.meta.main) {
  const app = new App();
  Application.setName("Input Device Manager");

  unixSignalAdd(UnixSignal.SIGINT, () => {
    eventLoop.stop();
    return true;
  });

  await eventLoop.start(app);
}
