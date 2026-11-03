/** The address is authoritative: a missed blank-flag update must not hide a
 * loaded page or leave the start-page overlay covering it. */
export function managedTabIsBlank(tab: { readonly url: string } | null): boolean {
	return tab === null || tab.url === "" || tab.url === "about:blank";
}
