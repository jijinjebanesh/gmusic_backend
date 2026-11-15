export function resolveOAuthRedirectUri({
  override,
  projectProductionUrl,
  deploymentUrl,
  localUrl,
  path,
}) {
  if (override) return override;

  const vercelUrl = projectProductionUrl || deploymentUrl;
  const baseUrl = vercelUrl
    ? (/^https?:\/\//i.test(vercelUrl) ? vercelUrl : `https://${vercelUrl}`)
    : localUrl;
  return new URL(path, baseUrl).toString();
}
