"""Check declared Python boundaries without importing application code.

The manifest owns domains, public entry modules and sensitive-operation owners.
This scanner only parses source. --report-only changes the exit status, never the
rules or the graph. --source-root also supports auditing a copied source tree.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path


def strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("expected a list of strings")
    return tuple(value)


def objects(value: object) -> list[dict]:
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ValueError("expected a list of objects")
    return value


def matches(module: str, selector: dict) -> bool:
    return module in selector.get("modules", []) or any(
        module == prefix or module.startswith(prefix + ".") for prefix in selector.get("prefixes", [])
    )


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    file: str
    line: int
    phase: str
    scope: str = ""
    dynamic: bool = False
    implicit: bool = False


@dataclass(frozen=True)
class Diagnostic:
    file: str
    line: int
    rule: str
    source: str
    target: str
    message: str
    allowed: tuple[str, ...] = ()
    chain: tuple[str, ...] = ()


@dataclass
class Module:
    name: str
    path: Path
    tree: ast.Module
    bindings: dict[str, str]


class Policy:
    def __init__(self, path: Path):
        self.path = path.resolve()
        self.data = json.loads(path.read_text())
        if not isinstance(self.data, dict) or self.data.get("schema_version") != 1:
            raise ValueError("architecture manifest requires schema_version=1")
        self.package = self.data["package"]
        if not isinstance(self.package, str) or not self.package.isidentifier():
            raise ValueError("package must be one Python identifier")
        self.domains = self.data["domains"]
        if not isinstance(self.domains, dict) or not self.domains:
            raise ValueError("domains must be a nonempty object")
        selectors: set[str] = set()
        for name, domain in self.domains.items():
            if not isinstance(domain, dict):
                raise ValueError(f"{name}: domain must be an object")
            for key in ("modules", "prefixes", "public", "imports"):
                for module in strings(domain.get(key, [])):
                    self.validate_module(module)
            for module in [*domain.get("modules", []), *domain.get("prefixes", [])]:
                if module in selectors:
                    raise ValueError(f"duplicate domain selector: {module}")
                selectors.add(module)
        for name, domain in self.domains.items():
            for module in domain.get("public", []):
                if self.owner(module) != name:
                    raise ValueError(f"{name}: public entry belongs to another domain: {module}")
            for module in domain.get("imports", []):
                owner = self.owner(module)
                if owner is None or module not in self.domains[owner].get("public", []):
                    raise ValueError(f"{name}: dependency must name a declared public module: {module}")
        self.pure = objects(self.data.get("pure_closures", []))
        for rule in self.pure:
            if not isinstance(rule.get("name"), str):
                raise ValueError("pure closure needs a name")
            for key in ("roots", "allowed"):
                selector = rule.get(key)
                if not isinstance(selector, dict) or not any(selector.values()):
                    raise ValueError(f"pure closure needs a nonempty {key} selector")
                for field in ("modules", "prefixes"):
                    for module in strings(selector.get(field, [])):
                        self.validate_module(module)
            strings(rule.get("forbidden_external", []))
        self.process = self.data["process_rules"]
        if not isinstance(self.process, dict) or not isinstance(self.process.get("owners"), dict):
            raise ValueError("process_rules requires exact module owners")
        for module, capabilities in self.process["owners"].items():
            self.validate_module(module)
            if self.owner(module) is None or not set(strings(capabilities)) <= {"spawn", "lifecycle"}:
                raise ValueError(f"invalid process owner: {module}")
        for key in ("spawn_apis", "reexec_apis", "lifecycle_apis", "lifecycle_methods", "forbidden_values"):
            strings(self.process.get(key, []))
        for rule in [*objects(self.process.get("scoped_apis", [])),
                     *objects(self.process.get("lifetime_guards", [])),
                     *objects(self.data.get("dynamic_loaders", []))]:
            self.validate_module(rule["module"])
            if self.owner(rule["module"]) is None or not isinstance(rule.get("scope"), str):
                raise ValueError("sensitive operation needs an owned module and exact scope")
        for module in strings(self.data.get("standalone_scripts", [])):
            self.validate_module(module)
        objects(self.data.get("embedded_sources", []))

    def validate_module(self, module: str) -> None:
        if not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", module):
            raise ValueError(f"module must be exact, without globs: {module}")
        if not self.internal(module):
            raise ValueError(f"module is outside {self.package}: {module}")

    def internal(self, module: str) -> bool:
        return module == self.package or module.startswith(self.package + ".")

    def owner(self, module: str) -> str | None:
        candidates = [(len(prefix), name) for name, domain in self.domains.items()
                      for prefix in domain.get("prefixes", [])
                      if module == prefix or module.startswith(prefix + ".")]
        exact = [name for name, domain in self.domains.items() if module in domain.get("modules", [])]
        return exact[0] if exact else max(candidates, default=(0, None))[1]


class Audit:
    def __init__(self, root: Path, policy: Policy):
        self.root, self.policy = root.resolve(), policy
        self.modules: dict[str, Module] = {}
        self.edges: list[Edge] = []
        self.diagnostics: list[Diagnostic] = []
        self.io_calls: dict[str, list[tuple[int, str]]] = {}
        for path in sorted(self.root.rglob("*.py")):
            parts = list(path.relative_to(self.root).with_suffix("").parts)
            if parts[-1] == "__init__":
                parts.pop()
            name = ".".join([policy.package, *parts])
            try:
                tree = ast.parse(path.read_text(), filename=str(path))
            except (SyntaxError, UnicodeError) as error:
                self.problem(name, path, getattr(error, "lineno", 1) or 1, "syntax", "", str(error))
                continue
            if name in self.modules:
                self.problem(name, path, 1, "duplicate-module", name, "both a module and a package define this name")
            self.modules[name] = Module(name, path, tree, {})
        self.names = set(self.modules)
        for name in list(self.names):
            self.names.update(self.parents(name))
        for module in self.modules.values():
            module.bindings = Reader(self, module).bind(module.tree.body)

    def parents(self, name: str) -> list[str]:
        parts = name.split(".")
        return [".".join(parts[:index]) for index in range(1, len(parts))]

    def problem(self, module: str, path: Path | str, line: int, rule: str, target: str,
                message: str, allowed: tuple[str, ...] = (), chain: tuple[str, ...] = ()) -> None:
        self.diagnostics.append(Diagnostic(str(path), line, rule, module, target, message, allowed, chain))

    def resolve_export(self, value: str, seen: frozenset[str] = frozenset()) -> str:
        if value in seen:
            return value
        parts = value.split(".")
        for length in range(len(parts) - 1, 0, -1):
            module = self.modules.get(".".join(parts[:length]))
            if module is not None:
                alias = module.bindings.get(parts[length])
                if alias:
                    next_value = ".".join([alias, *parts[length + 1:]])
                    if next_value != value:
                        return self.resolve_export(next_value, seen | {value})
                break
        return value

    def run(self) -> dict:
        if not self.modules:
            self.problem(self.policy.package, self.root, 1, "source-missing", "", "no Python modules found")
        for module in self.modules.values():
            reader = Reader(self, module)
            reader.bindings[0].update(module.bindings)
            if self.policy.owner(module.name) is None:
                self.problem(module.name, module.path, 1, "unowned-module", module.name,
                             "declare its target domain; existing imports do not grant permission")
            reader.parent_edges(module.name, 1)
            reader.visit(module.tree)
        self.boundaries()
        self.closures()
        self.cycles()
        self.standalone()
        self.diagnostics = sorted(set(self.diagnostics), key=lambda item: (
            item.file, item.line, item.rule, item.target, item.chain))
        self.edges = sorted(set(self.edges), key=lambda item: (
            item.source, item.line, item.target, item.phase, item.implicit, item.dynamic))
        return {
            "schema_version": 1, "package": self.policy.package, "source_root": str(self.root),
            "manifest": str(self.policy.path), "modules": len(self.modules),
            "domains": {name: self.policy.owner(name) for name in sorted(self.modules)},
            "edges": [asdict(edge) for edge in self.edges],
            "diagnostics": [asdict(item) for item in self.diagnostics],
        }

    def boundaries(self) -> None:
        for edge in self.edges:
            if edge.implicit or not self.policy.internal(edge.target):
                continue
            if edge.target not in self.names:
                self.problem(edge.source, edge.file, edge.line, "missing-module", edge.target,
                             "internal import has no source module or namespace package")
            source, target = self.policy.owner(edge.source), self.policy.owner(edge.target)
            if source is None or target is None or source == target:
                continue
            allowed = tuple(self.policy.domains[source].get("imports", []))
            public = tuple(self.policy.domains[target].get("public", []))
            if edge.target not in public:
                self.problem(edge.source, edge.file, edge.line, "private-entry", edge.target,
                             f"{source} accesses {target} implementation ({edge.phase})", public)
            elif edge.target not in allowed:
                self.problem(edge.source, edge.file, edge.line, "dependency", edge.target,
                             f"{source} has no declared dependency on this entry ({edge.phase})", allowed)

    def closures(self) -> None:
        outgoing: dict[str, list[Edge]] = {}
        for edge in self.edges:
            outgoing.setdefault(edge.source, []).append(edge)
        for rule in self.policy.pure:
            roots = sorted(name for name in self.modules if matches(name, rule["roots"]))
            pending = deque((root, (root,)) for root in roots)
            visited = set(roots)
            while pending:
                current, chain = pending.popleft()
                module = self.modules.get(current)
                if module and rule.get("forbid_io"):
                    for line, call in self.io_calls.get(current, []):
                        self.problem(current, module.path, line, "pure-io", call,
                                     f"{rule['name']}: pure closure performs file or environment IO", chain=chain)
                for edge in outgoing.get(current, []):
                    path = (*chain, edge.target)
                    if self.policy.internal(edge.target):
                        if not matches(edge.target, rule["allowed"]):
                            self.problem(edge.source, edge.file, edge.line, "pure-closure", edge.target,
                                         f"{rule['name']}: forbidden transitive dependency ({edge.phase})",
                                         tuple(rule["allowed"].get("modules", [])) +
                                         tuple(rule["allowed"].get("prefixes", [])), path)
                        if edge.target not in visited:
                            visited.add(edge.target)
                            pending.append((edge.target, path))
                    elif edge.target.split(".")[0] in rule.get("forbidden_external", []):
                        self.problem(edge.source, edge.file, edge.line, "pure-external", edge.target,
                                     f"{rule['name']}: forbidden external capability ({edge.phase})", chain=path)

    def cycles(self) -> None:
        # Includes delayed and type-only imports. Their phase remains visible in the
        # diagnostic; moving an edge into a function never makes a domain cycle pass.
        graph = {name: set() for name in self.modules}
        for edge in self.edges:
            if edge.target in graph:
                graph[edge.source].add(edge.target)
        indices: dict[str, int] = {}
        low: dict[str, int] = {}
        stack: list[str] = []
        active: set[str] = set()

        def visit(name: str) -> None:
            indices[name] = low[name] = len(indices)
            stack.append(name)
            active.add(name)
            for target in sorted(graph[name]):
                if target not in indices:
                    visit(target)
                    low[name] = min(low[name], low[target])
                elif target in active:
                    low[name] = min(low[name], indices[target])
            if low[name] != indices[name]:
                return
            component: list[str] = []
            while True:
                target = stack.pop()
                active.remove(target)
                component.append(target)
                if target == name:
                    break
            owners = {self.policy.owner(item) for item in component} - {None}
            if len(owners) < 2:
                return
            members = set(component)
            for edge in self.edges:
                if (edge.source in members and edge.target in members
                        and self.policy.owner(edge.source) != self.policy.owner(edge.target)):
                    self.problem(edge.source, edge.file, edge.line, "cross-domain-cycle", edge.target,
                                 f"cycle across {', '.join(sorted(owners))}; phase={edge.phase}",
                                 chain=tuple(sorted(component)))

        for name in sorted(graph):
            if name not in indices:
                visit(name)

    def standalone(self) -> None:
        for name in self.policy.data.get("standalone_scripts", []):
            module = self.modules.get(name)
            if module is None:
                continue
            for edge in self.edges:
                if edge.source == name and not edge.implicit and (
                    self.policy.internal(edge.target) or edge.target.split(".")[0] not in sys.stdlib_module_names
                ):
                    self.problem(name, module.path, edge.line, "standalone-import", edge.target,
                                 "deployed script must run with only the remote Python standard library")
        for item in self.policy.data.get("embedded_sources", []):
            module = self.modules.get(item["module"])
            if module is None:
                continue
            for node in module.tree.body:
                if not isinstance(node, ast.Assign) or not any(
                    isinstance(target, ast.Name) and target.id == item["symbol"] for target in node.targets
                ):
                    continue
                if not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
                    self.problem(module.name, module.path, node.lineno, "embedded-source", item["symbol"],
                                 "registered embedded source must be a statically inspectable string")
                    continue
                try:
                    tree = ast.parse(node.value.value)
                except SyntaxError as error:
                    self.problem(module.name, module.path, node.lineno, "embedded-source", item["symbol"], str(error))
                    continue
                for child in ast.walk(tree):
                    imports = ([alias.name for alias in child.names] if isinstance(child, ast.Import) else
                               [child.module or ""] if isinstance(child, ast.ImportFrom) else [])
                    for target in imports:
                        if target.split(".")[0] not in sys.stdlib_module_names or (
                            isinstance(child, ast.ImportFrom) and child.level
                        ):
                            self.problem(module.name, module.path, node.lineno, "embedded-import", target,
                                         f"{item['symbol']}: embedded deployment source is stdlib-only")


class Reader(ast.NodeVisitor):
    def __init__(self, audit: Audit, module: Module):
        self.audit, self.module = audit, module
        self.bindings: list[dict[str, str]] = [{}]
        self.constants: list[dict[str, object]] = [{"__file__": module.path,
            "__name__": module.name, "__package__": module.name if module.path.name == "__init__.py"
            else module.name.rpartition(".")[0]}]
        self.scope: list[str] = []
        self.function_depth = 0
        self.type_depth = 0

    def absolute(self, name: str, level: int = 0) -> str:
        if not level:
            return name
        package = self.module.name if self.module.path.name == "__init__.py" else self.module.name.rpartition(".")[0]
        parts = package.split(".")
        if level > len(parts):
            return "<outside-package>." + name
        return ".".join([*parts[:len(parts) - level + 1], *([name] if name else [])])

    def bind(self, body: list[ast.stmt]) -> dict[str, str]:
        found: dict[str, str] = {}

        def collect(node: ast.AST) -> None:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    found[alias.asname or alias.name.split(".")[0]] = alias.name if alias.asname else alias.name.split(".")[0]
            elif isinstance(node, ast.ImportFrom):
                base = self.absolute(node.module or "", node.level)
                for alias in node.names:
                    if alias.name != "*":
                        found[alias.asname or alias.name] = base + "." + alias.name
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                found[node.name] = self.module.name + "." + ".".join([*self.scope, node.name])
            elif not isinstance(node, ast.Lambda):
                for child in ast.iter_child_nodes(node):
                    collect(child)

        for statement in body:
            collect(statement)
        self.bindings.append(found)
        # Resolve simple aliases, including aliases exported by package initializers.
        for _ in range(3):
            for statement in body:
                for node in self.local_nodes(statement):
                    if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        for target in targets:
                            for variable, expression in self.assignments(target, node.value):
                                value = self.symbol(expression)
                                if value:
                                    found[variable] = value
        self.bindings.pop()
        return found

    def assignments(self, target: ast.AST, expression: ast.AST):
        if isinstance(target, ast.Name):
            yield target.id, expression
        elif isinstance(target, (ast.Tuple, ast.List)) and isinstance(expression, (ast.Tuple, ast.List)):
            if len(target.elts) == len(expression.elts):
                for left, right in zip(target.elts, expression.elts):
                    yield from self.assignments(left, right)

    def local_nodes(self, node: ast.AST):
        yield node
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            for child in ast.iter_child_nodes(node):
                yield from self.local_nodes(child)

    def symbol(self, node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            for bindings in reversed(self.bindings):
                if node.id in bindings:
                    return self.audit.resolve_export(bindings[node.id])
            return "builtins." + node.id if node.id in {"__import__", "exec", "eval", "compile", "open", "getattr"} else node.id
        if isinstance(node, ast.Attribute):
            return self.audit.resolve_export(self.symbol(node.value) + "." + node.attr)
        if isinstance(node, ast.Call):
            call = self.symbol(node.func)
            if call == "builtins.getattr" and len(node.args) >= 2:
                name = self.value(node.args[1])
                if isinstance(name, str):
                    return self.audit.resolve_export(self.symbol(node.args[0]) + "." + name)
            if call in {"importlib.import_module", "builtins.__import__"} and node.args:
                name = self.value(node.args[0])
                if isinstance(name, str) and not name.startswith("."):
                    if call == "builtins.__import__" and len(node.args) < 4 and not any(k.arg == "fromlist" for k in node.keywords):
                        return name.split(".")[0]
                    return name
        return ""

    def value(self, node: ast.AST) -> object:
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            for constants in reversed(self.constants):
                if node.id in constants:
                    return constants[node.id]
        if isinstance(node, ast.BinOp):
            left, right = self.value(node.left), self.value(node.right)
            if isinstance(node.op, ast.Add) and isinstance(left, str) and isinstance(right, str):
                return left + right
            if isinstance(node.op, ast.Div) and isinstance(left, Path) and isinstance(right, str):
                return left / right
        if isinstance(node, ast.JoinedStr):
            parts = [self.value(part.value) if isinstance(part, ast.FormattedValue) else self.value(part)
                     for part in node.values]
            if all(isinstance(part, (str, int)) for part in parts):
                return "".join(str(part) for part in parts)
        if isinstance(node, ast.Attribute) and node.attr == "parent":
            value = self.value(node.value)
            if isinstance(value, Path):
                return value.parent
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute) and node.value.attr == "parents":
            value, index = self.value(node.value.value), self.value(node.slice)
            if isinstance(value, Path) and isinstance(index, int) and 0 <= index < len(value.parents):
                return value.parents[index]
        if isinstance(node, ast.Call):
            name = self.symbol(node.func)
            if name == "pathlib.Path" and len(node.args) == 1:
                value = self.value(node.args[0])
                if isinstance(value, (str, Path)):
                    return Path(value)
            if isinstance(node.func, ast.Attribute):
                value = self.value(node.func.value)
                if isinstance(value, Path):
                    if node.func.attr in {"resolve", "absolute"} and not node.args:
                        return value.resolve()
                    if node.func.attr == "with_name" and len(node.args) == 1:
                        name = self.value(node.args[0])
                        if isinstance(name, str) and name and "/" not in name:
                            return value.with_name(name)
        return None

    def phase(self) -> str:
        return "type-checking" if self.type_depth else "function" if self.function_depth else "module"

    def edge(self, target: str, line: int, *, dynamic: bool = False, implicit: bool = False) -> None:
        self.audit.edges.append(Edge(self.module.name, target, str(self.module.path), line,
                                     self.phase(), ".".join(self.scope), dynamic, implicit))
        if not implicit:
            self.parent_edges(target, line)

    def parent_edges(self, target: str, line: int) -> None:
        for parent in self.audit.parents(target):
            module = self.audit.modules.get(parent)
            if module and module.path.name == "__init__.py" and parent != self.module.name:
                self.edge(parent, line, implicit=True)

    def problem(self, node: ast.AST, rule: str, target: str, message: str, allowed: tuple[str, ...] = ()) -> None:
        self.audit.problem(self.module.name, self.module.path, getattr(node, "lineno", 1), rule, target, message, allowed)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.edge(alias.name, node.lineno)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        base = self.absolute(node.module or "", node.level)
        if base.startswith("<outside-package>"):
            self.problem(node, "relative-import", base, "relative import escapes the source package")
            return
        for alias in node.names:
            candidate = base + "." + alias.name
            self.edge(candidate if candidate in self.audit.names else base, node.lineno)
            if alias.name == "*" and self.audit.policy.internal(base):
                self.problem(node, "wildcard-import", base, "internal re-exports must be explicit")

    def visit_If(self, node: ast.If) -> None:
        self.visit(node.test)
        contains_guard = any(self.symbol(child) == "typing.TYPE_CHECKING" for child in ast.walk(node.test))

        def runtime_value(expression: ast.AST) -> bool | None:
            if self.symbol(expression) == "typing.TYPE_CHECKING":
                return False
            if isinstance(expression, ast.Constant) and isinstance(expression.value, bool):
                return expression.value
            if isinstance(expression, ast.UnaryOp) and isinstance(expression.op, ast.Not):
                value = runtime_value(expression.operand)
                return not value if value is not None else None
            if isinstance(expression, ast.BoolOp):
                values = [runtime_value(value) for value in expression.values]
                if isinstance(expression.op, ast.And):
                    return False if False in values else True if all(value is True for value in values) else None
                return True if True in values else False if all(value is False for value in values) else None
            return None

        value = runtime_value(node.test) if contains_guard else None
        self.type_depth += int(value is False)
        for statement in node.body:
            self.visit(statement)
        self.type_depth -= int(value is False)
        self.type_depth += int(value is True)
        for statement in node.orelse:
            self.visit(statement)
        self.type_depth -= int(value is True)

    def function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for expression in [*node.decorator_list, *node.args.defaults,
                           *(value for value in node.args.kw_defaults if value is not None),
                           *(arg.annotation for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
                             if arg.annotation is not None), *([node.returns] if node.returns else [])]:
            self.visit(expression)
        self.scope.append(node.name)
        bindings = self.bind(node.body)
        for argument in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                         *([node.args.vararg] if node.args.vararg else []),
                         *([node.args.kwarg] if node.args.kwarg else [])]:
            bindings[argument.arg] = "<local>." + argument.arg
        self.bindings.append(bindings)
        self.constants.append({})
        self.function_depth += 1
        for statement in node.body:
            self.visit(statement)
        self.function_depth -= 1
        self.constants.pop()
        self.bindings.pop()
        self.scope.pop()

    visit_FunctionDef = function
    visit_AsyncFunctionDef = function

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for value in [*node.decorator_list, *node.bases, *(keyword.value for keyword in node.keywords)]:
            self.visit(value)
        self.scope.append(node.name)
        self.bindings.append(self.bind(node.body))
        self.constants.append({})
        for statement in node.body:
            self.visit(statement)
        self.constants.pop()
        self.bindings.pop()
        self.scope.pop()

    def visit_Lambda(self, node: ast.Lambda) -> None:
        self.function_depth += 1
        self.visit(node.body)
        self.function_depth -= 1

    def visit_Assign(self, node: ast.Assign | ast.AnnAssign) -> None:
        if node.value is not None:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                for variable, expression in self.assignments(target, node.value):
                    self.constants[-1][variable] = self.value(expression)
                    alias = self.symbol(expression)
                    if alias:
                        self.bindings[-1][variable] = alias
        self.generic_visit(node)

    visit_AnnAssign = visit_Assign

    def visit_Attribute(self, node: ast.Attribute) -> None:
        self.forbidden_value(node)
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        self.forbidden_value(node)

    def forbidden_value(self, node: ast.AST) -> None:
        symbol = self.symbol(node)
        if symbol in self.audit.policy.process.get("forbidden_values", []):
            self.problem(node, "lifetime-unlock", symbol, "explicit unlock can release a child's inherited lease")

    def visit_Call(self, node: ast.Call) -> None:
        self.forbidden_value(node)
        name = self.symbol(node.func)
        rules = self.audit.policy.process
        capabilities = rules["owners"].get(self.module.name, [])
        scoped = any(item["module"] == self.module.name and item["scope"] == ".".join(self.scope)
                     and name in item["apis"] for item in rules.get("scoped_apis", []))
        for kind in ("spawn", "reexec", "lifecycle"):
            method = name.rpartition(".")[2] in rules.get("lifecycle_methods", [])
            if name in rules.get(kind + "_apis", []) or (kind == "lifecycle" and method):
                if kind not in capabilities and not scoped:
                    owners = tuple(module for module, values in rules["owners"].items() if kind in values)
                    self.problem(node, "process-" + kind, name or ast.unparse(node.func),
                                 f"{kind} is restricted to its declared lifecycle owner", owners)
        for guard in rules.get("lifetime_guards", []):
            if guard["module"] == self.module.name and guard["scope"] == ".".join(self.scope):
                if name in guard["forbidden_apis"] or (isinstance(node.func, ast.Attribute)
                                                      and node.func.attr in guard["forbidden_methods"]):
                    self.problem(node, "lifetime-close", name, "inherited lifetime descriptors remain open until process exit")
        self.dynamic(node, name)
        if name == "builtins.getattr" and len(node.args) >= 2 and not isinstance(self.value(node.args[1]), str):
            receiver = self.symbol(node.args[0])
            if receiver.split(".")[0] in {"subprocess", "asyncio", "os", "importlib", "fcntl", "runpy"}:
                self.problem(node, "sensitive-api-unresolved", receiver,
                             "computed access to a sensitive API must have a statically known attribute")
        if (name in {"builtins.open", "os.open", "os.getenv", "os.getenvb", "os.putenv", "os.chdir"}
                or isinstance(node.func, ast.Attribute) and node.func.attr in {
                    "read_text", "read_bytes", "write_text", "write_bytes", "open", "mkdir", "unlink",
                    "rmdir", "iterdir", "glob", "rglob", "stat", "lstat", "exists", "is_file", "is_dir"}):
            self.audit.io_calls.setdefault(self.module.name, []).append((node.lineno, name or ast.unparse(node.func)))
        self.generic_visit(node)

    def dynamic(self, node: ast.Call, name: str) -> None:
        approved = any(item["module"] == self.module.name and item["scope"] == ".".join(self.scope)
                       and name in item["apis"] for item in self.audit.policy.data.get("dynamic_loaders", []))
        if name in {"importlib.import_module", "builtins.__import__", "runpy.run_module"}:
            argument = node.args[0] if node.args else next((keyword.value for keyword in node.keywords
                if keyword.arg == ("mod_name" if name == "runpy.run_module" else "name")), None)
            target = self.value(argument) if argument is not None else None
            if name == "builtins.__import__":
                level_node = node.args[4] if len(node.args) >= 5 else next(
                    (keyword.value for keyword in node.keywords if keyword.arg == "level"), None)
                level = self.value(level_node) if level_node is not None else 0
                if not isinstance(level, int) or level < 0:
                    target = None
                elif level and isinstance(target, str):
                    target = self.absolute(target, level)
                    if target.startswith("<outside-package>"):
                        target = None
            if isinstance(target, str) and target:
                if target.startswith("."):
                    package_node = next((keyword.value for keyword in node.keywords if keyword.arg == "package"), None)
                    package = self.value(package_node) if package_node is not None else (
                        self.value(node.args[1]) if len(node.args) > 1 else None)
                    if not isinstance(package, str):
                        target = None
                    else:
                        level = len(target) - len(target.lstrip("."))
                        parts = package.split(".")
                        target = ".".join([*parts[:len(parts) - level + 1], target.lstrip(".")]).rstrip(".") if level <= len(parts) else None
                if target:
                    self.edge(target, node.lineno, dynamic=True)
                    return
            self.problem(node, "dynamic-import-unresolved", name,
                         "computed imports need a statically determinable target; no internal loader exemption exists")
        elif name in {"importlib.util.spec_from_file_location", "importlib.machinery.SourceFileLoader", "runpy.run_path"}:
            index = 0 if name == "runpy.run_path" else 1
            argument = node.args[index] if len(node.args) > index else next((keyword.value for keyword in node.keywords
                if keyword.arg == ("path_name" if name == "runpy.run_path" else "location")), None)
            value = self.value(argument) if argument is not None else None
            if isinstance(value, (str, Path)):
                path = Path(value)
                if path.is_absolute() and path.resolve().is_relative_to(self.audit.root):
                    candidates = [module.name for module in self.audit.modules.values() if module.path.resolve() == path.resolve()]
                    if candidates:
                        self.edge(candidates[0], node.lineno, dynamic=True)
                        return
                    self.problem(node, "dynamic-import-unresolved", str(path), "internal file loader target has no Python module")
                    return
            if not approved:
                self.problem(node, "dynamic-loader", name, "file loader must name an internal module or a registered external extension site")
        elif name in {"builtins.exec", "builtins.eval", "builtins.compile", "importlib.util.module_from_spec"}:
            if not approved:
                self.problem(node, "dynamic-code", name, "code execution is reserved for an explicitly registered extension loader")
        elif isinstance(node.func, ast.Attribute) and node.func.attr in {"exec_module", "load_module"}:
            if not approved:
                self.problem(node, "dynamic-loader", name, "unregistered executable module loader")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[1] / "architecture.json")
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--report-only", action="store_true", help="report every violation but exit zero")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    try:
        policy = Policy(args.manifest)
        root = args.source_root or policy.path.parent / policy.data["source_root"]
        report = Audit(root, policy).run()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"architecture configuration error: {error}", file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for item in report["diagnostics"]:
            allowed = "; allowed=" + ", ".join(item["allowed"]) if item["allowed"] else ""
            chain = "; via=" + " -> ".join(item["chain"]) if item["chain"] else ""
            print(f"{item['file']}:{item['line']}: {item['rule']}: {item['source']} -> {item['target']}: {item['message']}{allowed}{chain}")
        print(f"Architecture: {report['modules']} modules, {len(report['edges'])} edges, "
              f"{len(report['diagnostics'])} violations" + (" (report-only)" if args.report_only else ""))
    return 0 if args.report_only or not report["diagnostics"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
