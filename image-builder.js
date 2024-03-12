const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { program } = require('commander');

function show_message(type, message) {
  if (type == "error") {
    console.error(message);
  } else if (type == "fatal") {
    console.error(message);
    process.exit(1);
  } else {
    console.log(message);
  }
}

function qemu_wrapper(qemu_cmd, qemu_args, ready_callback) {
  show_message(
    "info",
    "starting qemu process with command: " +
      qemu_cmd +
      " " +
      qemu_args.join(" ")
  );
  const qemuProcess = spawn(qemu_cmd, qemu_args);

  let waitForLogin = (() => {
    let concat = "";
    return (data) => {
      concat += data.toString();
      if (concat.includes("login")) {
        ready_callback(qemuProcess);
        waitForLogin = () => {};
      }
    };
  })();

  qemuProcess.stdout.on("data", (data) => {
    waitForLogin(data);
  });

  qemuProcess.on("close", (code) => {
    show_message("info", `qemu exited with code ${code}`);
  });

  return qemuProcess;
};

function start_vm(qemu_bin, cpu, arch, bios, machine, filename, pubkey) {
  show_message("info", "Starting VM");

  const qemu_executable = `${qemu_bin}/qemu-system-${arch}`;
  let qemu_args = [
    "-machine",
    machine,
    "-cpu",
    cpu,
    "-smp",
    "2",
    "-bios",
    bios,
    "-m",
    "512",
    "-nographic",
    "-drive",
    `file=${filename},format=qcow2`
  ];

  qemu_wrapper(qemu_executable, qemu_args, (qemu_process) => {
    show_message("info", "VM is started");
    let ssh_ready = false;
    let do_ssh_callback = () => {
      qemu_process.stdin.write(
        "mkdir -p ~/.ssh && cat > ~/.ssh/authorized_keys <<EOF && chmod 600 ~/.ssh/authorized_keys && echo 'sshd_enable=\"YES\"' >> /etc/rc.conf && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && /etc/rc.d/sshd start && /etc/rc.d/sshd restart\n"
      );
      qemu_process.stdin.write(pubkey + "\nEOF\n");
    };

    let waitForPrompt = (() => {
      let concat = "";
      return (msg) => {
        concat += msg;
        if (concat.includes("root@freebsd:~ #")) {
          if (!ssh_ready) {
            ssh_ready = true;
            concat = "";
            do_ssh_callback();
          } else {
            show_message("info", "SSH okay. VM is ready to use after shutting down.");
            qemu_process.stdin.write("shutdown -p now\n");
            waitForPrompt = () => {};
          }
        }
      };
    })();

    qemu_process.stdout.on("data", (data) => {
      const msg = data.toString();
      console.log(msg);
      waitForPrompt(msg);
    });
    qemu_process.stdin.write("root\n");
  });
};

try {
  program
    .option("--qemu <qemu>", "bin directory for QEMU")
    .option("--os <type>", "OS type")
    .option("--arch <arch>", "CPU architecture")
    .option("--image <image>", "Path to the qcow2 image file")
    .option("--pubkey <pubkey>", "Path to the public key file");
  
  program.parse();

  const options = program.opts();

  let image_filename = options.image;
  if (!fs.existsSync(image_filename)) {
    show_message("fatal", `Cannot find image file: ${image_filename}`);
  }

  const arch = options.arch;
  let cpu = "",
    bios = "",
    machine = "";
  switch (arch) {
    case "amd64":
    case "x86_64":
      machine = "pc";
      cpu = "qemu64";
      bios = "/usr/share/qemu/OVMF.fd";
      break;
    case "i386":
      machine = "pc";
      cpu = "Penryn";
      bios = "/usr/share/qemu/OVMF.fd";
      break;
    case "aarch64":
      machine = "virt,gic-version=3";
      cpu = "cortex-a72";
      bios = "edk2-aarch64-code.fd";
      break;
    case "riscv64":
      machine = "virt";
      cpu = "rv64";
      bios = "opensbi-riscv64-generic-fw_dynamic.bin";
      break;
    default:
      show_message("fatal", `Unknown architecture: ${arch}`);
  }

  const pubkey = fs.readFileSync(options.pubkey, "utf8");

  start_vm(options.qemu, cpu, arch, bios, machine, image_filename, pubkey);
} catch (error) {
  show_message("fatal", error.message);
}
