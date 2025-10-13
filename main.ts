import {
  type Adw1_ as Adw_,
  DenoGLibEventLoop,
  type Gio2_ as Gio_,
  type GLib2_ as GLib_,
  type Gtk4_ as Gtk_,
  kw,
  type NamedArgument,
  python,
} from "@sigma/gtk-py";

const gi = python.import("gi");
gi.require_version("Gtk", "4.0");
gi.require_version("Adw", "1");

export const Gtk: Gtk_.Gtk = python.import("gi.repository.Gtk");
export const Adw: Adw_.Adw = python.import("gi.repository.Adw");
export const Gio: Gio_.Gio = python.import("gi.repository.Gio");
export const GLib: GLib_.GLib = python.import("gi.repository.GLib");
const eventLoop = new DenoGLibEventLoop(GLib);

interface Device {
  name: string;
  id: string;
  eventPath?: string;
  type: string;
}

interface DeviceState extends Device {
  grabbed: boolean;
  process?: Deno.ChildProcess;
  eventPath?: string; // Store for killing the right process
}

// Cache for Flatpak installation path
let flatpakInstallPath: string | null | undefined = undefined;

// Get the Flatpak installation path on the host
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
      // Use host's pkexec with bundled libinput
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
        // Save previous device if it's complete
        if (currentDevice.name && currentDevice.id && currentDevice.eventPath) {
          devices.push(currentDevice as Device);
        }
        // Start new device
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

    // Don't forget the last device
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
    // Note: This must be sync, so we use the cached value
    // Make sure getFlatpakInstallPath() was called during listDevices()
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

    const cmd = new Deno.Command(command, {
      args: args,
      stdout: "piped",
      stderr: "piped",
    });

    return cmd.spawn();
  } catch (error) {
    console.error("Error grabbing device:", error);
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
        // In Flatpak: find and kill the specific evtest process by matching the device path
        // Kill all matching PIDs in a single pkexec call to avoid multiple auth prompts
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
            // Kill all PIDs in one pkexec call
            const killCmd = new Deno.Command("flatpak-spawn", {
              args: ["--host", "pkexec", "kill", "-TERM", ...pids],
              stdout: "null",
              stderr: "null",
            });
            await killCmd.output();
          }
        }
      } else {
        // Native: use the PID directly
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
  #app: Adw_.Application;
  #win: Gtk_.ApplicationWindow;
  #listBox: Gtk_.ListBox;
  #devices: Map<string, DeviceState> = new Map();

  constructor(app: Adw_.Application) {
    this.#app = app;

    this.#win = new Gtk.ApplicationWindow();
    this.#win.set_title("Input Device Manager");
    this.#win.set_default_size(700, 500);
    this.#win.set_application(this.#app);
    this.#win.connect(
      "close-request",
      // @ts-ignore FIXME
      python.callback(() => this.#onCloseRequest()),
    );

    // Header bar
    const headerBar = Gtk.HeaderBar();

    const refreshBtn = Gtk.Button();
    refreshBtn.set_label("↻ Refresh");
    refreshBtn.add_css_class("suggested-action");
    refreshBtn.connect(
      "clicked",
      // @ts-ignore FIXME
      python.callback(() => this.#refreshDevices()),
    );
    headerBar.pack_end(refreshBtn);

    // Main container with Adw styling
    const adwBox = Adw.ToolbarView();
    this.#win.set_child(adwBox);
    adwBox.add_top_bar(headerBar);

    const mainContent = Gtk.Box();
    mainContent.set_orientation(Gtk.Orientation.VERTICAL);
    adwBox.set_content(mainContent);

    // Title section
    const titleBox = Gtk.Box();
    titleBox.set_orientation(Gtk.Orientation.VERTICAL);
    titleBox.set_margin_top(24);
    titleBox.set_margin_bottom(16);
    titleBox.set_margin_start(24);
    titleBox.set_margin_end(24);

    const title = Gtk.Label();
    title.set_text("Input Devices");
    title.set_xalign(0);
    const titleAttrs = python.import("gi.repository.Pango").AttrList.new();
    const titleWeight = python.import("gi.repository.Pango").attr_weight_new(
      700,
    );
    const titleSize = python.import("gi.repository.Pango").attr_size_new(
      20 * 1024,
    );
    titleAttrs.insert(titleWeight);
    titleAttrs.insert(titleSize);
    title.set_attributes(titleAttrs);

    const subtitle = Gtk.Label();
    subtitle.set_text("Manage input device access");
    subtitle.set_xalign(Gtk.Align.START);
    subtitle.set_opacity(0.65);
    subtitle.set_margin_top(4);

    titleBox.append(title);
    titleBox.append(subtitle);
    mainContent.append(titleBox);

    // Scrolled window with Adw ListBox
    const scrolled = Gtk.ScrolledWindow();
    scrolled.set_vexpand(true);
    scrolled.set_hexpand(true);

    this.#listBox = Gtk.ListBox();
    this.#listBox.add_css_class("boxed-list");
    this.#listBox.set_margin_top(12);
    this.#listBox.set_margin_bottom(24);
    this.#listBox.set_margin_start(12);
    this.#listBox.set_margin_end(12);
    this.#listBox.set_selection_mode(Gtk.SelectionMode.NONE); // GTK_SELECTION_NONE

    scrolled.set_child(this.#listBox);
    mainContent.append(scrolled);

    this.#refreshDevices();
  }

  #refreshDevices = async () => {
    // Clean up old UI
    let child = this.#listBox.get_first_child();
    while (
      // Need to compare to true to avoid NotImplemented issue in upstream
      child.__eq__(python.None).valueOf() !== true
    ) {
      const next = child.get_next_sibling();
      this.#listBox.remove(child);
      child = next;
    }
    // also remove emptyLabel

    const devices = await listDevices();

    if (devices.length === 0) {
      const emptyLabel = Gtk.Label();
      emptyLabel.set_text("No input devices found");
      emptyLabel.set_opacity(0.5);
      emptyLabel.set_margin_top(24);
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

      // Use Adw.ActionRow for better Adw integration
      const row = Adw.ActionRow();
      row.set_title(device.name);
      row.set_subtitle(`${device.eventPath} • ${device.type}`);

      // Toggle button as suffix
      const btn = Gtk.ToggleButton();
      btn.set_active(state.grabbed);
      btn.set_valign(Gtk.Align.CENTER);

      const btnLabel = Gtk.Label();
      this.#updateButtonLabel(btnLabel, state.grabbed);
      btn.set_child(btnLabel);

      btn.connect(
        "toggled",
        python.callback(() => {
          this.#toggleDevice(device.id, btn, btnLabel);
        }),
      );

      row.add_suffix(btn);
      row.set_activatable(false);

      this.#listBox.append(row);
    }
  };

  #updateButtonLabel(label: Gtk_.Label, grabbed: boolean) {
    if (grabbed) {
      label.set_text("🔒 Grabbed");
      label.set_opacity(1);
    } else {
      label.set_text("🔓 Released");
      label.set_opacity(0.85);
    }
  }

  #toggleDevice = (
    deviceId: string,
    btn: Gtk_.ToggleButton,
    btnLabel: Gtk_.Label,
  ) => {
    const state = this.#devices.get(deviceId);
    if (!state) return;

    if (btn.get_active().valueOf()) {
      // Grab device
      const process = grabDevice(state.eventPath!);
      if (process) {
        state.grabbed = true;
        state.process = process;
        this.#updateButtonLabel(btnLabel, true);
        btn.add_css_class("destructive-action");
      } else {
        btn.set_active(false);
      }
    } else {
      // Release device
      releaseDevice(state.process, state.eventPath);
      state.grabbed = false;
      state.process = undefined;
      this.#updateButtonLabel(btnLabel, false);
      btn.remove_css_class("destructive-action");
    }
  };

  #onCloseRequest = async () => {
    for (const [_, state] of this.#devices) {
      await releaseDevice(state.process, state.eventPath);
    }

    eventLoop.stop();
    return false;
  };

  present() {
    this.#win.present();
  }
}

class App extends Adw.Application {
  #win?: MainWindow;

  constructor(kwArg: NamedArgument) {
    super(kwArg);
    this.connect("activate", this.#onActivate);
  }

  #onActivate = python.callback((_kwarg, app: Adw_.Application) => {
    if (!this.#win) this.#win = new MainWindow(app);
    this.#win.present();
  });
}

if (import.meta.main) {
  const app = new App(kw`application_id=${"com.example.hardwaretoggle"}`);
  const signal = python.import("signal");

  GLib.unix_signal_add(
    GLib.PRIORITY_HIGH,
    signal.SIGINT,
    python.callback(() => {
      eventLoop.stop();
      app.quit();
    }),
  );

  app.register();
  app.activate();
  eventLoop.start();
}
