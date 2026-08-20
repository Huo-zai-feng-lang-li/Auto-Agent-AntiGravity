function shouldNotifyTaskCompletion({
  notifyEnabled,
  isFocused,
  now,
  lastNotifiedAt,
  cooldownMs,
}) {
  if (!notifyEnabled || isFocused) return false;
  return now - lastNotifiedAt >= cooldownMs;
}

module.exports = { shouldNotifyTaskCompletion };
