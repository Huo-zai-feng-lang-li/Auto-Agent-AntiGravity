function shouldNotifyTaskCompletion({
  notifyEnabled,
  isFocused = false,
  now,
  lastNotifiedAt,
  cooldownMs = 3000,
}) {
  if (!notifyEnabled) return false;
  if (isFocused) return false;
  return now - lastNotifiedAt >= cooldownMs;
}

module.exports = { shouldNotifyTaskCompletion };
