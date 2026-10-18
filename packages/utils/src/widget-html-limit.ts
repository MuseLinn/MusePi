// Shared ceiling for one model-authored HTML surface (inline widget face,
// rendered page, board card).
//
// The value is a wire/body bound, not a taste call: a face's HTML travels in
// the tool call's input, which the daemon stores with the message and streams
// to every client. 200k stays under the 1MB JSON body cap even for text that
// encodes to several bytes per character, and is far more than a chart, table
// or mockup page needs. Over it the card degrades to an empty notice rather
// than silently rendering nothing — so accepting more here only defers a
// failure to the client.
//
// It lives in its own module so both sides of the dependency can read it:
// client-core owns the renderer and coding-agent owns the tool, and neither
// imports the other.
export const MAX_WIDGET_HTML = 200_000;
