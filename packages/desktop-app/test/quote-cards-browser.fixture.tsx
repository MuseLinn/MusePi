import type { DisplayContext } from "@musepi/client-core/src/messages/display-context";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QuoteCards } from "../src/components/composer/quote-cards";

function Fixture() {
	const [contexts, setContexts] = useState<DisplayContext[]>([
		{
			kind: "browser-annotation",
			pageUrl: "https://example.com",
			prompt: "Page: https://example.com\nElement 1: button\nComment: old comment",
		},
	]);
	return (
		<QuoteCards
			contexts={contexts}
			onRemove={index => setContexts(current => current.filter((_, candidate) => candidate !== index))}
			onChange={(index, context) =>
				setContexts(current =>
					current.map((candidate, candidateIndex) => (candidateIndex === index ? context : candidate)),
				)
			}
		/>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("QuoteCards fixture root is missing");
createRoot(root).render(<Fixture />);
