"""Generates the pydantic models from the pruned API specs in python/spec/.

    python python/scripts/generate_models.py          # write the files
    python python/scripts/generate_models.py --check  # exit 1 on drift

scripts/generate-api.ts writes python/spec/*.json from the spec commit in
api-spec.lock, so these models come from the same commit as the TypeScript
types. The generator knows only the schema constructs those specs use, and
fails on any other, so a new construct upstream cannot be dropped silently.

Every JSON `number` becomes `Decimal`: the kit never puts money in a float.
"""

from __future__ import annotations

import json
import keyword
import re
import sys
from pathlib import Path
from typing import Any

PYTHON_DIR = Path(__file__).resolve().parent.parent
PACKAGE_DIR = PYTHON_DIR / "src" / "tgbp_kit"

SPECS = [
    ("core.json", PACKAGE_DIR / "models.py"),
    ("swap.json", PACKAGE_DIR / "swap_models.py"),
]

# The body IdempotencyKey field is deprecated; the client sends the header instead.
OMIT = {
    "MintCreateRequest": {"IdempotencyKey"},
    "RedemptionCreateRequest": {"IdempotencyKey"},
}
# A swap intent's id is its idempotency key; the client generates one if you omit it.
OPTIONAL = {"CreateSwapIntentRequest": {"id"}}

SCHEMA_KEYS = {
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "nullable",
    "format",
    "$ref",
    "anyOf",
    "allOf",
    "additionalProperties",
    "default",
    "deprecated",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
    "multipleOf",
}
Schema = dict[str, Any]


def pascal(name: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", name)
    return "".join(part[:1].upper() + part[1:] for part in parts if part)


def py_name(name: str) -> str:
    """A valid Python identifier for a JSON field name."""
    ident = re.sub(r"\W", "_", name)
    if not ident.isidentifier() or keyword.iskeyword(ident):
        ident += "_"
    return ident


def literal(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        return repr(value)
    if isinstance(value, int):
        return repr(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, float):
        return f'Decimal("{value!r}")'
    raise ValueError(f"unsupported literal {value!r}")


class Generator:
    def __init__(self, spec: Schema) -> None:
        self.components: Schema = spec.get("components", {})
        self.paths: Schema = spec["paths"]
        self.blocks: list[str] = []
        self.names: set[str] = set()
        self.imports: set[str] = set()

    def resolve(self, node: Schema) -> Schema:
        ref = node.get("$ref")
        if ref is None:
            return node
        _, _, kind, name = ref.split("/")
        target: Schema = self.components[kind][name]
        return self.resolve(target)

    def claim(self, name: str) -> str:
        if name in self.names:
            raise ValueError(f"two models would be called {name}")
        self.names.add(name)
        return name

    def annotation(self, schema: Schema, hint: str) -> str:
        """The Python type for a schema; inline objects become their own model named after `hint`."""
        unknown = set(schema) - SCHEMA_KEYS
        if unknown:
            raise ValueError(f"{hint}: unsupported schema keys {sorted(unknown)}")
        base = self.base_annotation(schema, hint)
        # Constraints (minimum, pattern, ...) are not generated: the API enforces them on requests,
        # and a response must never fail on one, or a created record would be lost to the caller.
        if schema.get("nullable"):
            base = f"{base} | None"
        return base

    def base_annotation(self, schema: Schema, hint: str) -> str:
        if "$ref" in schema:
            return str(schema["$ref"]).split("/")[-1]
        if "allOf" in schema:
            if len(schema["allOf"]) != 1:
                raise ValueError(f"{hint}: allOf with more than one member")
            return self.annotation(schema["allOf"][0], hint)
        if "anyOf" in schema:
            members = [
                self.annotation(member, f"{hint}Option{i + 1}") for i, member in enumerate(schema["anyOf"])
            ]
            return " | ".join(members)
        if "enum" in schema:
            self.imports.add("Literal")
            # `| str`: a response may carry a value newer than the pinned spec.
            return f"Literal[{', '.join(literal(value) for value in schema['enum'])}] | str"
        kind = schema.get("type")
        if kind == "string":
            if schema.get("format") == "date-time":
                self.imports.add("AwareDatetime")
                return "AwareDatetime"
            return "str"
        if kind == "integer":
            return "int"
        if kind == "number":
            self.imports.add("Decimal")
            return "Decimal"
        if kind == "boolean":
            return "bool"
        if kind == "array":
            return f"list[{self.annotation(schema['items'], hint + 'Item')}]"
        if kind == "object":
            if "properties" not in schema:
                extra = schema.get("additionalProperties", True)
                self.imports.add("Any")
                if extra is True:
                    return "dict[str, Any]"
                return f"dict[str, {self.annotation(extra, hint + 'Value')}]"
            return self.model(hint, schema)
        raise ValueError(f"{hint}: unsupported schema {json.dumps(schema)[:120]}")

    def model(self, name: str, schema: Schema, *, query: bool = False) -> str:
        """Emits a model class. A query model only ever serialises, so it aliases on output only."""
        self.claim(name)
        required = set(schema.get("required", [])) - OPTIONAL.get(name, set())
        lines = [f"class {name}(Model):"]
        for field, prop in sorted(schema["properties"].items()):
            if field in OMIT.get(name, set()):
                continue
            annotation = self.annotation(prop, name + pascal(field))
            attr = py_name(field)
            if attr != field:
                self.imports.add("Field")
                if query:
                    alias = f'Field(serialization_alias="{field}")'
                else:
                    self.imports.add("AliasChoices")
                    alias = (
                        f'Field(validation_alias=AliasChoices("{field}", "{attr}"), '
                        f'serialization_alias="{field}")'
                    )
            else:
                alias = None
            if field in required:
                default = f" = {alias}" if alias else ""
            else:
                if not annotation.endswith("| None"):
                    annotation = f"{annotation} | None"
                default = f" = {alias[:-1]}, default=None)" if alias else " = None"
            lines.append(f"    {attr}: {annotation}{default}")
        if len(lines) == 1:
            lines.append("    pass")
        self.blocks.append("\n".join(lines))
        return name

    def alias(self, name: str, schema: Schema) -> None:
        self.claim(name)
        self.imports.add("TypeAlias")
        self.blocks.append(f"{name}: TypeAlias = {self.annotation(schema, name)}")

    def operations(self) -> list[tuple[str, Schema]]:
        ops = []
        for item in self.paths.values():
            for method, op in item.items():
                if method != "parameters":
                    ops.append((op["operationId"], {**op, "_shared": item.get("parameters", [])}))
        return sorted(ops)

    def query_model(self, op_id: str, op: Schema) -> None:
        params = [self.resolve(p) for p in [*op["_shared"], *op.get("parameters", [])]]
        query = [p for p in params if p["in"] == "query"]
        if not query:
            return
        # Defaults belong to the server: an unset field is left out of the query.
        properties = {p["name"]: {k: v for k, v in p["schema"].items() if k != "default"} for p in query}
        required = [p["name"] for p in query if p.get("required")]
        schema = {"type": "object", "properties": properties, "required": required}
        self.model(pascal(op_id) + "Query", schema, query=True)

    def response_model(self, op_id: str, op: Schema) -> None:
        """A model for an operation's inline success body; one that is a $ref needs none."""
        for status in ("200", "201"):
            response = op.get("responses", {}).get(status)
            if response is None:
                continue
            body = self.resolve(response).get("content", {}).get("application/json", {})
            schema = body.get("schema")
            if schema is None:
                raise ValueError(f"{op_id}: the {status} response has no application/json schema")
            if "$ref" not in schema:
                self.model(pascal(op_id) + "Response", schema)
            return

    def render(self, source: str) -> str:
        schemas = sorted(self.components.get("schemas", {}).items())
        models = {
            name for name, schema in schemas if schema.get("type") == "object" and "properties" in schema
        }
        # Aliases run at import time, so they come first and may not name a model.
        for name, schema in schemas:
            if name not in models:
                self.alias(name, schema)
                if any(re.search(rf"\b{m}\b", self.blocks[-1]) for m in models):
                    raise ValueError(f"alias {name} names a model; the generator cannot order that")
        for name, schema in schemas:
            if name in models:
                self.model(name, schema)
        for op_id, op in self.operations():
            self.query_model(op_id, op)
            self.response_model(op_id, op)
        return self.module(source)

    def module(self, source: str) -> str:
        typing = sorted(self.imports & {"Annotated", "Any", "Literal", "TypeAlias"})
        pydantic = sorted(self.imports & {"AliasChoices", "AwareDatetime", "Field"})
        head = [
            f"# Generated by python/scripts/generate_models.py from python/spec/{source},",
            "# which scripts/generate-api.ts writes at the commit in api-spec.lock.",
            "# Do not edit by hand. Regenerate: python python/scripts/generate_models.py",
            "",
            "from __future__ import annotations",
            "",
        ]
        if "Decimal" in self.imports:
            head.append("from decimal import Decimal")
        if typing:
            head.append(f"from typing import {', '.join(typing)}")
        head.append("")
        if pydantic:
            head.append(f"from pydantic import {', '.join(pydantic)}")
            head.append("")
        head.append("from ._base import Model")
        exports = ["", "__all__ = [", *(f'    "{n}",' for n in sorted(self.names)), "]"]
        return "\n".join(head) + "\n\n\n" + "\n\n\n".join(self.blocks) + "\n" + "\n".join(exports) + "\n"


def build() -> dict[Path, str]:
    files = {}
    for source, output in SPECS:
        spec = json.loads((PYTHON_DIR / "spec" / source).read_text())
        files[output] = Generator(spec).render(source)
    return files


def main() -> int:
    check = "--check" in sys.argv[1:]
    drifted = False
    for path, rendered in build().items():
        current = path.read_text() if path.exists() else ""
        if check:
            if current != rendered:
                print(f"{path} has drifted from python/spec; run python python/scripts/generate_models.py")
                drifted = True
        else:
            path.write_text(rendered)
    if check and not drifted:
        print("Python models match python/spec.")
    return 1 if drifted else 0


if __name__ == "__main__":
    sys.exit(main())
