import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// Selection geometry is unavailable in jsdom; the editor still uses real document transactions.
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
Range.prototype.getClientRects = () => [];
window.scrollTo = () => {};
