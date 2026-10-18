"""Per-op code keys for shape_apply's op-result cache (pure Python: ast, hashlib).

The op cache used to key every unit on the sha of the whole shape_apply.py (and shape_layers.py), so an edit to
the kerb code made every cut-out miss. Here an op kind's code key is the source text of exactly the code that
op can run: the closure from its entry in the dispatch table (`RUNNERS[kind]`) plus the cache framework
(`FRAMEWORK_ROOTS`), following every module-level function, class and assignment it names, transitively -
into the sibling modules (a .py next to shape_apply: shape_layers, shape_surfaces, shape_kerb ...) by the same
rules, function by function (`sl.select` reaches shape_layers.select and what that names, not the layer
validation that imports shape_kerb).

Resolution rules (conservative: an edge too many costs a cache miss, one too few a stale result in the scene):
- every Name a reached statement loads that is a module-level def/class/assignment of its module is followed,
  in function bodies, nested functions and lambdas, decorators, default arguments and class bodies alike; a
  module-level statement that mutates a name (`X.update(...)`, `X[k] = ...`, `a, b = ...`) belongs to that
  name, and so does every function anywhere in the module that assigns it through `global` or mutates it in
  place;
- `mod.attr` / `from mod import attr` / a function-local `import mod as m` of a sibling follows `attr` in that
  module; a sibling module object used any other way (passed on, getattr) takes that whole module;
- `obj.attr` where `obj` is not a module: every class of that module (except shape_apply's driver `Applier`,
  which runs ops and is never handed to one) defining `attr` as a method, class attribute or `self.attr` is
  followed (ctx.box -> Ctx, unit.reads -> Unit, ctx.runner.run -> UnitRunner);
- `PLANNERS` (shape_apply's per-kind unit planners) is indexed by the running op's kind: only that kind's
  planner is followed, as long as every reached use of `plan_units` is a call `plan_units(ctx, op)` passing the
  op itself; otherwise all of them;
- module-level statements of a reached module that bind nothing (`if HERE not in sys.path: ...`, the
  `__main__` block) are text in the key, their names not followed;
- what cannot be resolved statically: a loaded name that is neither bound in the statement, module-level,
  imported nor a builtin; eval / exec / compile / globals() / locals() / vars() / __import__ / importlib;
  getattr/setattr/hasattr/delattr with a computed name on something of the module or on `sys`; `sys.modules`
  by `__name__`; a reached `import shape_apply`. In shape_apply that makes the op's key the whole file plus
  every sibling it imports (whole); in a sibling, that sibling and every sibling it imports, whole. The reason
  is logged and kept in `problems`.

`code_key(path, kind)` parses once per process and source (~0.1-0.5 s for all kinds).
"""

import ast
import builtins
import hashlib
import os

KEY_VERSION = "golfmap-opkey-1"
DISPATCH = "RUNNERS"
KIND_TABLES = {"PLANNERS": "plan_units"}   # table -> the function that indexes it with op["op"]
FRAMEWORK_ROOTS = ("OpCache", "UnitRunner", "Unit", "History", "Ctx", "capture_state", "state_hash",
                   "apply_state", "remove_object", "op_canonical", "env_key", "plan_units", "build_ctx",
                   "_index_objects", "object_mode", "spline_meshes")
DRIVER_CLASSES = ("Applier",)
SELF_MODULES = ("shape_apply", "__main__")
DYNAMIC_CALLS = {"eval", "exec", "compile", "globals", "locals", "vars", "__import__"}
ATTR_FUNCS = {"getattr", "setattr", "hasattr", "delattr"}
MUTATORS = {"append", "extend", "insert", "pop", "popitem", "clear", "update", "setdefault", "add", "discard",
            "remove", "sort", "reverse", "__setitem__", "__delitem__"}
IMPLICIT = {"__file__", "__name__", "__doc__", "__builtins__", "__spec__", "__loader__", "__package__"}
DEF_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


def _sha1(data):
    return hashlib.sha1(data).hexdigest()


def _walk(node):
    """ast.walk as a list, kept on the node (every statement is walked by several passes)."""
    nodes = getattr(node, "_gm_walk", None)
    if nodes is None:
        nodes = list(ast.walk(node))
        node._gm_walk = nodes
    return nodes


def _root(node):
    """The Name at the bottom of an attribute / subscript / call chain, or None."""
    while True:
        if isinstance(node, ast.Attribute):
            node = node.value
        elif isinstance(node, ast.Subscript):
            node = node.value
        elif isinstance(node, ast.Call):
            node = node.func
        else:
            return node.id if isinstance(node, ast.Name) else None


def _bound(node):
    """Names bound anywhere inside a node (arguments, assignment targets, imports, defs, loop / with / except /
    comprehension targets, global and nonlocal declarations)."""
    out = set()
    for n in _walk(node):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            out.add(n.id)
        elif isinstance(n, ast.arg):
            out.add(n.arg)
        elif isinstance(n, DEF_TYPES):
            out.add(n.name)
        elif isinstance(n, ast.alias):
            out.add((n.asname or n.name).split(".")[0])
        elif isinstance(n, ast.ExceptHandler) and n.name:
            out.add(n.name)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            out.update(n.names)
        elif isinstance(n, ast.MatchAs) and n.name:
            out.add(n.name)
    return out


def _bound_local(node):
    """For a module-level statement that is not a def: only names bound in nested scopes (lambdas,
    comprehensions) are local; its own targets are module-level names."""
    out = set()
    for n in _walk(node):
        if isinstance(n, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
            out |= _bound(n)
    return out


def _imports(node):
    """(module, imported name or None for `import module`, alias bound) of every import inside a node."""
    out = []
    for n in _walk(node):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.asname:
                    out.append((a.name, None, a.asname))
                else:  # `import a.b` binds `a`
                    out.append((a.name.split(".")[0], None, a.name.split(".")[0]))
        elif isinstance(n, ast.ImportFrom):
            mod = ("." * (n.level or 0)) + (n.module or "")
            for a in n.names:
                out.append((mod, a.name, a.asname or a.name))
    return out


def _mentions_self(node):
    for n in _walk(node):
        if isinstance(n, ast.Name) and n.id == "__name__":
            return True
        if isinstance(n, ast.Constant) and n.value in SELF_MODULES:
            return True
    return False


def _class_members(cls):
    out = set()
    for n in cls.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.add(n.name)
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                for x in _walk(t):
                    if isinstance(x, ast.Name):
                        out.add(x.id)
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            out.add(n.target.id)
    for n in _walk(cls):
        if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Store) and isinstance(n.value, ast.Name) \
                and n.value.id == "self":
            out.add(n.attr)
    return out


def _scope_nodes(n):
    """The nodes of a module-level statement in its own scope (not inside a nested def, lambda or
    comprehension; a nested def / class node itself is kept)."""
    out, todo = [], [n]
    nested = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda, ast.ListComp, ast.SetComp,
              ast.DictComp, ast.GeneratorExp)
    while todo:
        x = todo.pop()
        out.append(x)
        if x is not n and isinstance(x, nested):
            continue
        todo.extend(ast.iter_child_nodes(x))
    return out


def _module_targets(n):
    """Module-level names a non-def statement binds or mutates."""
    out = set()
    targets = []
    if isinstance(n, (ast.If, ast.With, ast.Try, ast.For, ast.While, getattr(ast, "TryStar", ast.Try),
                      getattr(ast, "Match", ast.If))):
        for x in _scope_nodes(n):
            if isinstance(x, ast.Name) and isinstance(x.ctx, (ast.Store, ast.Del)):
                out.add(x.id)
            elif isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and x is not n:
                out.add(x.name)
            elif isinstance(x, ast.alias):
                out.add((x.asname or x.name).split(".")[0])
            elif isinstance(x, ast.ExceptHandler) and x.name:
                out.add(x.name)
            elif isinstance(x, (ast.Subscript, ast.Attribute)) and isinstance(x.ctx, (ast.Store, ast.Del)):
                r = _root(x)
                if r:
                    out.add(r)
            elif isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr in MUTATORS \
                    and isinstance(x.func.value, ast.Name):
                out.add(x.func.value.id)
        return out
    if isinstance(n, ast.Assign):
        targets = n.targets
    elif isinstance(n, (ast.AnnAssign, ast.AugAssign)):
        targets = [n.target]
    elif isinstance(n, ast.Expr) and isinstance(n.value, ast.Call):
        r = _root(n.value.func)
        if r is not None and isinstance(n.value.func, ast.Attribute):
            out.add(r)
    elif isinstance(n, ast.Delete):
        targets = n.targets
    for t in targets:
        if isinstance(t, (ast.Tuple, ast.List)):
            for x in _walk(t):
                if isinstance(x, ast.Name):
                    out.add(x.id)
        else:
            r = t.id if isinstance(t, ast.Name) else _root(t)
            if r is not None:
                out.add(r)
    return out


def _mutated_globals(fn):
    """Module-level names a def changes: assigned through `global`, or (when not a local) mutated in place by
    item / attribute assignment or a mutating method call."""
    declared = set()
    for n in _walk(fn):
        if isinstance(n, ast.Global):
            declared.update(n.names)
    out = set()
    locals_ = _bound(fn) - declared
    for n in _walk(fn):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)) and n.id in declared:
            out.add(n.id)
        elif isinstance(n, (ast.Subscript, ast.Attribute)) and isinstance(n.ctx, (ast.Store, ast.Del)):
            r = _root(n)
            if r and r not in locals_:
                out.add(r)
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in MUTATORS \
                and isinstance(n.func.value, ast.Name) and n.func.value.id not in locals_:
            out.add(n.func.value.id)
    out.discard("self")
    return out


class _Stmt:
    def __init__(self, index, node, lines):
        self.index = index
        self.node = node
        start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
        self.text = "\n".join(lines[start - 1:node.end_lineno])
        self.lines = node.end_lineno - start + 1
        self.kind = type(node).__name__
        self.name = getattr(node, "name", None)
        self.label = self.name or self.text.split("\n")[0][:60]
        self.bound = _bound(node) if isinstance(node, DEF_TYPES) else _bound_local(node)
        self.imports = _imports(node) if isinstance(node, DEF_TYPES) else []


class Module:
    """One source file, parsed once: statements, what defines / mutates each module-level name, classes'
    members, module-level imports, dict-literal tables."""

    def __init__(self, path, source=None, root=False):
        self.path = os.path.abspath(path)
        self.here = os.path.dirname(self.path)
        self.name = os.path.splitext(os.path.basename(self.path))[0]
        if source is None:
            with open(self.path, "r", encoding="utf-8") as f:
                source = f.read()
        self.source = source
        self.sha = _sha1(source.encode("utf-8"))
        tree = ast.parse(source)
        lines = source.splitlines()
        self.stmts = [_Stmt(i, n, lines) for i, n in enumerate(tree.body)]
        self.defs = {}         # module-level name -> statement indices defining or mutating it
        self.prelude = []      # statements binding nothing: text in the key
        self.aliases = {}      # module-level import alias -> (module, imported name or None)
        self.members = {}      # attribute name -> classes defining it
        self.tables = {}       # dict-literal table name -> {key: value name}
        for s in self.stmts:
            n = s.node
            if isinstance(n, DEF_TYPES):
                self.defs.setdefault(n.name, []).append(s.index)
                if isinstance(n, ast.ClassDef) and not (root and n.name in DRIVER_CLASSES):
                    for m in _class_members(n):
                        self.members.setdefault(m, set()).add(n.name)
            elif isinstance(n, (ast.Import, ast.ImportFrom)):
                for mod, attr, alias in _imports(n):
                    self.aliases[alias] = (mod, attr)
                    self.defs.setdefault(alias, []).append(s.index)
            elif isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant):
                continue  # docstring
            else:
                names = _module_targets(n)
                for t in names:
                    self.defs.setdefault(t, []).append(s.index)
                if not names:
                    self.prelude.append(s.index)
            if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name) \
                    and isinstance(n.value, ast.Dict):
                tab = {}
                for k, v in zip(n.value.keys, n.value.values):
                    if isinstance(k, ast.Constant) and isinstance(k.value, str) and isinstance(v, ast.Name):
                        tab[k.value] = v.id
                if len(tab) == len(n.value.keys):
                    self.tables[n.targets[0].id] = tab
        self.mutated_by = {}   # module-level name -> defs that rebind (global) or mutate it
        for s in self.stmts:
            if isinstance(s.node, DEF_TYPES):
                for name in _mutated_globals(s.node):
                    if name in self.defs and name not in self.aliases and s.index not in self.defs[name]:
                        self.mutated_by.setdefault(name, set()).add(s.index)

    def statements_of(self, name):
        return sorted(set(self.defs.get(name, [])) | self.mutated_by.get(name, set()))

    def imported_siblings(self, is_sibling):
        """Every sibling module any statement of this file imports."""
        out = set()
        for s in self.stmts:
            for mod, attr, _ in _imports(s.node):
                if is_sibling(mod):
                    out.add(mod.split(".")[0])
        return out


class Graph:
    """shape_apply (the root) and the sibling modules next to it, parsed on demand."""

    def __init__(self, path, source=None):
        self.root = Module(path, source, root=True)
        self.here = self.root.here
        self.modules = {self.root.name: self.root}
        self._memo = {}

    def is_sibling(self, mod):
        top = mod.split(".")[0]
        return bool(top) and not mod.startswith(".") and top not in SELF_MODULES and top != self.root.name \
            and os.path.isfile(os.path.join(self.here, top + ".py"))

    def module(self, name):
        if name not in self.modules:
            self.modules[name] = Module(os.path.join(self.here, name + ".py"))
        return self.modules[name]

    def kinds(self):
        return sorted(self.root.tables.get(DISPATCH, {}))

    # ------------------------------------------------------------ the closure

    def closure(self, kind):
        """{kind, key, wholeFile (reason or None), problems, functions, classes, statements, lines, modules
        (per module: statements or "whole"), names} of an op kind."""
        root = self.root
        problems, root_problems = [], []
        dispatch = root.tables.get(DISPATCH, {})
        todo = [(root.name, r) for r in FRAMEWORK_ROOTS]
        if kind in dispatch:
            todo.append((root.name, dispatch[kind]))
        else:
            root_problems.append(f"{kind} is not in {DISPATCH}")
        included = {}          # module -> statement indices
        whole = {}             # sibling module -> reason
        synthetic = []
        seen = set()
        narrowed = []

        def visit(todo):
            while todo:
                mname, name = todo.pop()
                if (mname, name) in seen:
                    continue
                seen.add((mname, name))
                if mname in whole:
                    continue
                m = self.module(mname)
                if m is root and name in KIND_TABLES and name in root.tables:
                    tab = root.tables[name]
                    if kind in tab:
                        narrowed.append(name)
                        synthetic.append("%s[%r] = %s" % (name, kind, tab[kind]))
                        todo.append((mname, tab[kind]))
                        continue
                    problems.append(f"{kind} has no entry in {name}: every entry followed")
                inc = included.setdefault(mname, set())
                for i in m.statements_of(name):
                    if i in inc:
                        continue
                    inc.add(i)
                    pushes, wholes, probs = self._analysis(m, i)
                    todo.extend(pushes)
                    for sib, why in wholes.items():
                        whole.setdefault(sib, why)
                    for p in probs:
                        (root_problems if m is root else problems).append(p)
                        if m is not root and mname not in whole:
                            whole[mname] = p

        visit(todo)
        # a kind table narrowed to one entry is only sound when every reached use of its indexer passes the op
        for table in narrowed:
            fn = KIND_TABLES[table]
            bad = self._kind_uses_unsure(fn, included.get(root.name, set()))
            if bad:
                problems.append(f"{fn} is used without the op itself in {bad}: every {table} entry followed")
                more = []
                for k, v in sorted(root.tables[table].items()):
                    if k != kind:
                        synthetic.append("%s[%r] = %s" % (table, k, v))
                        more.append((root.name, v))
                visit(more)
        # a whole sibling brings every sibling it imports, whole
        todo_w = sorted(whole)
        while todo_w:
            for x in sorted(self.module(todo_w.pop()).imported_siblings(self.is_sibling)):
                if x not in whole:
                    whole[x] = "imported by a whole module"
                    todo_w.append(x)
        whole_file = "; ".join(root_problems) if root_problems else None
        h = hashlib.sha256()
        h.update(KEY_VERSION.encode())
        modules = {}
        if whole_file:
            allsib = self._all_siblings(root)
            h.update(b"\0whole file\0" + root.source.encode("utf-8"))
            for m in sorted(allsib):
                h.update(("\0%s:%s" % (m, self.module(m).sha)).encode())
            modules = dict({root.name: "whole"}, **{m: "whole" for m in sorted(allsib)})
            stmts = list(root.stmts)
        else:
            h.update(("\0kind:%s" % kind).encode())
            stmts = []
            for mname in sorted(set(included) | set(whole)):
                m = self.module(mname)
                if mname in whole:
                    h.update(("\0module %s whole:%s" % (mname, m.sha)).encode())
                    modules[mname] = "whole"
                    continue
                idx = sorted(set(m.prelude) | included[mname])
                if not included[mname]:
                    continue
                h.update(("\0module %s" % mname).encode())
                for i in idx:
                    h.update(b"\0" + m.stmts[i].text.encode("utf-8"))
                modules[mname] = len(included[mname])
                if m is root:
                    stmts = [m.stmts[i] for i in sorted(included[mname])]
            for t in sorted(synthetic):
                h.update(b"\0" + t.encode("utf-8"))
        return {"kind": kind, "key": h.hexdigest(), "wholeFile": whole_file, "problems": root_problems + problems,
                "functions": sum(1 for s in stmts if s.kind in ("FunctionDef", "AsyncFunctionDef")),
                "classes": sum(1 for s in stmts if s.kind == "ClassDef"),
                "statements": len(stmts), "lines": sum(s.lines for s in stmts), "modules": modules,
                "wholeModules": dict(whole),
                "names": {mn: sorted(self.module(mn).stmts[i].label for i in ix) for mn, ix in sorted(included.items())}}

    def _all_siblings(self, m):
        out = set()
        todo = sorted(m.imported_siblings(self.is_sibling))
        out.update(todo)
        while todo:
            for x in self.module(todo.pop()).imported_siblings(self.is_sibling):
                if x not in out:
                    out.add(x)
                    todo.append(x)
        return out

    def _kind_uses_unsure(self, fn, included):
        """Reached statements loading `fn` other than as a call `fn(ctx, op)` passing the op's own name."""
        bad = []
        for i in sorted(included):
            s = self.root.stmts[i]
            if s.name == fn:
                continue
            loads = [n for n in _walk(s.node) if isinstance(n, ast.Name) and n.id == fn and isinstance(n.ctx, ast.Load)]
            if not loads:
                continue
            ok = [c for c in _walk(s.node) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                  and c.func.id == fn and len(c.args) == 2 and isinstance(c.args[1], ast.Name)
                  and c.args[1].id == "op" and not c.keywords]
            rebinds_op = any(isinstance(n, ast.Name) and n.id == "op" and isinstance(n.ctx, (ast.Store, ast.Del))
                             for n in _walk(s.node))
            if len(ok) != len(loads) or rebinds_op:
                bad.append(s.label)
        return bad

    def _analysis(self, m, i):
        """(pushes, whole siblings, problems) of statement i of module m, computed once."""
        k = (m.name, i)
        if k not in self._memo:
            pushes, wholes = [], {}
            probs = self._follow(m, m.stmts[i], pushes, wholes)
            self._memo[k] = (pushes, wholes, probs)
        return self._memo[k]

    def _follow(self, m, s, todo, whole):
        """Push the (module, name) pairs a statement reaches; return what in it cannot be resolved."""
        problems = []
        root = m is self.root
        # import aliases visible in the statement: its own (function-local) imports win over the module's
        local = {alias: (mod, attr) for mod, attr, alias in s.imports}
        for mod, attr, alias in s.imports:
            if mod.split(".")[0] in SELF_MODULES or (attr is None and mod.split(".")[0] == self.root.name):
                problems.append(f"{m.name}.{s.label}: imports {mod}")
            if mod.split(".")[0] == "importlib":
                problems.append(f"{m.name}.{s.label}: imports importlib")

        def alias_of(name):
            if name in local:
                return local[name]
            if name in m.aliases and name not in s.bound:
                return m.aliases[name]
            return None

        consumed = set()
        for n in _walk(s.node):
            if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and isinstance(n.value.ctx, ast.Load):
                a = alias_of(n.value.id)
                if a is not None and a[1] is None:       # `module.attr`
                    consumed.add(id(n.value))
                    if self.is_sibling(a[0]):
                        todo.append((a[0].split(".")[0], n.attr))
            elif isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in ("getattr", "hasattr") \
                    and len(n.args) >= 2 and isinstance(n.args[0], ast.Name) and isinstance(n.args[1], ast.Constant) \
                    and isinstance(n.args[1].value, str):
                a = alias_of(n.args[0].id)
                if a is not None and a[1] is None:       # getattr(module, "attr")
                    consumed.add(id(n.args[0]))
                    if self.is_sibling(a[0]):
                        todo.append((a[0].split(".")[0], n.args[1].value))
        for n in _walk(s.node):
            if not (isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)):
                continue
            name = n.id
            a = alias_of(name)
            if a is not None:
                if name in m.aliases and name not in local:
                    todo.append((m.name, name))           # the import statement itself is part of the text
                if self.is_sibling(a[0]):
                    sib = a[0].split(".")[0]
                    if a[1] is not None:
                        todo.append((sib, a[1]))          # `from sibling import x`
                    elif id(n) not in consumed and sib not in whole:
                        whole[sib] = f"{m.name}.{s.label} uses the module object {name}"
                elif a[0].split(".")[0] in SELF_MODULES and id(n) not in consumed:
                    problems.append(f"{m.name}.{s.label}: uses {a[0]}")
                elif a[0].startswith(".") or (a[1] is not None and a[0] in SELF_MODULES):
                    problems.append(f"{m.name}.{s.label}: imports from {a[0]}")
                continue
            if name in m.defs:
                todo.append((m.name, name))               # (also when a local shadows it somewhere in the def)
            elif name in s.bound or name in IMPLICIT or hasattr(builtins, name):
                continue
            else:
                problems.append(f"{m.name}.{s.label}: unresolved name {name}")
        # attributes of objects (not modules): every class of this module defining that attribute
        for n in _walk(s.node):
            if isinstance(n, ast.Attribute) and id(n.value) not in consumed:
                for cls in sorted(m.members.get(n.attr, ())):
                    todo.append((m.name, cls))
        for c in _walk(s.node):
            if not isinstance(c, ast.Call):
                continue
            f = c.func
            if isinstance(f, ast.Name) and f.id in DYNAMIC_CALLS and f.id not in s.bound:
                problems.append(f"{m.name}.{s.label}: calls {f.id}()")
            if isinstance(f, ast.Name) and f.id in ATTR_FUNCS and len(c.args) >= 2 \
                    and not (isinstance(c.args[1], ast.Constant) and isinstance(c.args[1].value, str)):
                r = _root(c.args[0])
                if r == "sys" or (r is not None and r in m.defs and r not in m.aliases and r not in s.bound) \
                        or (r is not None and alias_of(r) is not None and self.is_sibling(alias_of(r)[0])):
                    problems.append(f"{m.name}.{s.label}: {f.id}() with a computed name on {r}")
            if isinstance(f, ast.Attribute) and f.attr == "get" and isinstance(f.value, ast.Attribute) \
                    and f.value.attr == "modules" and _root(f.value) == "sys" and c.args and _mentions_self(c.args[0]):
                problems.append(f"{m.name}.{s.label}: sys.modules.get({ast.unparse(c.args[0])})")
        for n in _walk(s.node):
            if isinstance(n, ast.Subscript) and isinstance(n.value, ast.Attribute) and n.value.attr == "modules" \
                    and _root(n.value) == "sys" and _mentions_self(n.slice):
                problems.append(f"{m.name}.{s.label}: sys.modules[{ast.unparse(n.slice)}]")
        return problems


_CACHE = {}


def graph(path, source=None):
    """The parsed graph, cached per path and root source text (siblings are read once per process)."""
    if source is None:
        with open(path, "r", encoding="utf-8") as f:
            source = f.read()
    k = (os.path.abspath(path), _sha1(source.encode("utf-8")))
    if k not in _CACHE:
        _CACHE.clear()
        _CACHE[k] = (Graph(path, source), {})
    return _CACHE[k]


def code_key(path, kind, source=None, log=print):
    """The closure record of one op kind (cached per process and source); logs a whole-file fallback once."""
    g, keys = graph(path, source)
    if kind not in keys:
        c = g.closure(kind)
        keys[kind] = c
        if c["wholeFile"] and log:
            log(f"[shape_opkey] {kind}: whole-file code key ({c['wholeFile']})")
        for mn, why in c["wholeModules"].items():
            if log:
                log(f"[shape_opkey] {kind}: whole module {mn} ({why})")
    return keys[kind]


def forget(path, modules=None):
    """These sibling modules were reloaded: read their source again on the next code key (None: everything)."""
    for k in list(_CACHE):
        if k[0] != os.path.abspath(path):
            continue
        if modules is None:
            del _CACHE[k]
            continue
        g, keys = _CACHE[k]
        for m in modules:
            g.modules.pop(m, None)
        g._memo = {}
        keys.clear()


def code_keys(path, source=None):
    g, _ = graph(path, source)
    return {k: code_key(path, k, source, log=None) for k in g.kinds()}


if __name__ == "__main__":
    import json
    import sys
    import time
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    p = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), "shape_apply.py")
    t = time.time()
    ks = code_keys(p)
    took = time.time() - t
    for k, c in ks.items():
        print("%-28s %s functions %3d classes %2d lines %5d %s%s" % (
            k, c["key"][:12], c["functions"], c["classes"], c["lines"],
            " ".join("%s:%s" % (mn, v) for mn, v in c["modules"].items() if mn != "shape_apply"),
            ("  WHOLE FILE: " + c["wholeFile"]) if c["wholeFile"] else ""))
        for pr in c["problems"]:
            print("    note:", pr)
        for mn, why in c["wholeModules"].items():
            print("    whole %s: %s" % (mn, why))
    if "--names" in sys.argv:
        print(json.dumps({k: c["names"] for k, c in ks.items()}, indent=1))
    print("%.3f s" % took)
