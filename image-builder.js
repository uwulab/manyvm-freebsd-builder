const fs = require("fs");
const path = require("path");
const { spawn, execSync, spawnSync } = require("child_process");
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

async function start_vm(qemu_bin, cpu, arch, bios, machine, filename, pubkey, privkey) {
  show_message("info", "Starting VM");

  const qemu_executable = `${qemu_bin}/qemu-system-${arch}`;
  let qemu_args = [
    "-machine", machine,
    "-cpu", cpu,
    "-smp", "2",
    "-bios", bios,
    "-m", "512",
    "-nographic",
    "-drive", `file=${filename},format=qcow2`,
    "-netdev", `user,id=net0,hostfwd=tcp::2222-:22`,
    "-device", "virtio-net-pci,netdev=net0"
  ];

  qemu_wrapper(qemu_executable, qemu_args, (qemu_process) => {
    show_message("info", "VM is started");
    let ssh_ready = false;
    let ssh_done = false;
    // let ssh_setup_done = false;
    let pkg_install_start = false;
    let pkg_install_in_progress = false;
    let pkg_install_done = false;
    let qemu_exited = false;
    qemu_process.on("close", (code) => {
      qemu_exited = true;
      show_message("info", `qemu exited with code ${code}`);
    });
    const cleanup = () => {
      setTimeout(() => {
        if (qemu_exited) {
          show_message("info", "VM is stopped.");
        } else {
          show_message("info", "force shutdown if not stopped in 30 seconds.");
          qemu_process.kill();
        }
      }, 30000)
    }
    let do_ssh_callback = () => {
      let cmd = "mkdir -p /root/.ssh\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      cmd = "echo 'sshd_enable=\"YES\"' >> /etc/rc.conf\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      cmd = "echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      cmd = "cat > /root/.ssh/authorized_keys <<EOF && chmod 600 /root/.ssh/authorized_keys\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      const pubkey_chunks = pubkey.match(/.{1,32}/g)
      pubkey_chunks.forEach((chunk) => {
        qemu_process.stdin.write(chunk)
        show_message("info", chunk)
        execSync("sleep 1")
      })
      qemu_process.stdin.write("\nEOF\n\n")
      execSync("sleep 1")
      cmd = "/etc/rc.d/sshd start && /etc/rc.d/sshd restart\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 10")
      cmd = "service sshd enable && service sshd start\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 3")
      cmd = "pw user add -n runner -c runner -d /home/runner -m -s /usr/local/bin/bash\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 5")
      cmd = "mkdir -p /home/runner/.ssh\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      cmd = "cp /root/.ssh/authorized_keys /home/runner/.ssh/authorized_keys\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      cmd = "chown -R runner /home/runner\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      cmd = "chmod 600 /home/runner/.ssh/authorized_keys\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")
      cmd = "pw group mod wheel -m runner\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
      execSync("sleep 1")

      ssh_done = true;
    };

    let do_pkg_install = () => {
      cmd = "pkg install -y bash sudo\n"
      qemu_process.stdin.write(cmd)
      show_message("info", cmd)
    }

    // let do_ssh_setup = () => {
    //   show_message("info", "Setting up via SSH");
    //   const ssh_cmd = `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 -i ${privkey} root@localhost`;

    //   const run_ssh = (cmd) => {
    //     const current_command = `${ssh_cmd} ${cmd}`;
    //     console.log(`ssh ${current_command}`);
    //     const {status} = spawnSync('ssh', current_command.split(' '), {
    //       stdio: "inherit",
    //       shell: true
    //     });
    //     if (status !== 0) {
    //       show_message("error", `Failed to run: ${cmd}`);
    //     }
    //   };

    //   run_ssh("pkg install -y bash sudo");

    //   ssh_setup_done = true;
    // };

    let show_stdout = false;
    let enter_presser = undefined;
    let waitForPrompt = (() => {
      let concat = "";
      return (data) => {
        if (show_stdout) {
          process.stdout.write(data);
        }
        const msg = data.toString();
        concat += msg;
        if (concat.includes("root@freebsd:~ #")) {
          if (!ssh_ready) {
            ssh_ready = true;
            concat = "";
            do_ssh_callback();
          } else {
            if (ssh_done && !pkg_install_start) {
              show_message("info", "SSH okay. Will do setup now.");
              pkg_install_start = true;
              show_stdout = true;
              concat = "";
              do_pkg_install();
            } else {
              if (pkg_install_start) {
                if (!pkg_install_in_progress) {
                  pkg_install_in_progress = concat.includes("Extracting");
                  concat = "";
                  enter_presser = setInterval(() => {
                    qemu_process.stdin.write("\n");
                  }, 1000);
                } else {
                  clearInterval(enter_presser);
                  show_message("info", "pkg install done. VM will be ready to use after shutting down.");
                  pkg_install_done = true;
                  qemu_process.stdin.write("echo 'runner ALL=(ALL) NOPASSWD: ALL' >> /usr/local/etc/sudoers\n")
                  execSync("sleep 1")
                  qemu_process.stdin.write("shutdown -p now\n");
                  execSync("sleep 1")
                  cleanup();
                  waitForPrompt = () => {};
                }
              }
            }
          }
        }
      };
    })();

    qemu_process.stdout.on("data", (data) => {
      waitForPrompt(data);
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
    .option("--pubkey <pubkey>", "Path to the public key file")
    .option("--privkey <privkey>", "Path to the private key file")
  
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

  start_vm(options.qemu, cpu, arch, bios, machine, image_filename, pubkey, options.privkey);
} catch (error) {
  show_message("fatal", error.message);
}
