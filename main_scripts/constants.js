
const DEFAULT_BANNED_COMMANDS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf *",
  "format c:",
  "del /f /s /q",
  "rd /s /q",
  "rmdir /s /q",
  ":(){:|:&};:",
  "dd if=",
  "mkfs.",
  "> /dev/sda",
  "chmod -R 777 /",
  "shutdown",
  "reboot",
  "powershell -Command Clear-Disk",
  "Initialize-Disk",
  "Invoke-WebRequest",
  "curl",
  "wget",
  "nc -e",
  "bash -i",
  "cp /dev/zero",
  "mv ~ /dev/null"
];

const DEFAULT_POLL_FREQUENCY = 1000;

module.exports = {
  DEFAULT_BANNED_COMMANDS,
  DEFAULT_POLL_FREQUENCY
};
