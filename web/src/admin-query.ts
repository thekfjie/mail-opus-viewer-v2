export function accountSearchFromQuery(query: string): string {
  const params = new URLSearchParams(query);
  return (params.get("q") || params.get("search") || "").trim();
}
