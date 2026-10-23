import { describe, expect, test } from "vitest";
import { hostWorkingDirectory } from "../src/launch.ts";
import { requirePythonBackend } from "../src/python-backend.ts";

describe("desktop launch", () => {
	test("requires the packaged Python backend and does not choose another host", () => {
		expect(requirePythonBackend("/Apps/amazme-backend")).toBe("/Apps/amazme-backend");
		expect(() => requirePythonBackend(undefined)).toThrow("桌面需要包内的 Python 后端");
		expect(() => requirePythonBackend("")).toThrow("桌面需要包内的 Python 后端");
	});

	test("runs the backend in the launching directory unless a project is set", () => {
		expect(hostWorkingDirectory({}, "/repo")).toBe("/repo");
		expect(hostWorkingDirectory({ AMAZME_GUI_CWD: "/work" }, "/repo")).toBe("/work");
	});
});
