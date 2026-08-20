function shouldNotifyTaskCompletion({
  notifyEnabled,
  isFocused,
  now,
  lastNotifiedAt,
  cooldownMs,
}) {
  if (!notifyEnabled) return false;
  if (isFocused) return false;
  return now - lastNotifiedAt >= cooldownMs;
}

module.exports = { shouldNotifyTaskCompletion };
