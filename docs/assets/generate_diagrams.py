#!/usr/bin/env python3
"""Rebuild editable documentation diagrams using the adjacent official icon set."""
from pathlib import Path
import base64
import xml.etree.ElementTree as ET

OUT = Path(__file__).resolve().parent
BLUE, PURPLE, TEAL, GRAY = "#0078D4", "#5C2D91", "#036C70", "#605E5C"


class Diagram:
    def __init__(self, name, title, subtitle, width=1600, height=920):
        self.name, self.n = name, 0
        self.doc = ET.Element("mxfile", host="Electron", version="26.0.0")
        page = ET.SubElement(self.doc, "diagram", id=name, name=title)
        model = ET.SubElement(page, "mxGraphModel", grid="1", gridSize="10", page="1",
                              pageWidth=str(width), pageHeight=str(height), math="0", shadow="0")
        self.root = ET.SubElement(model, "root")
        ET.SubElement(self.root, "mxCell", id="0")
        ET.SubElement(self.root, "mxCell", id="1", parent="0")
        self.box("", 20, 20, width * .55, 6, f"rounded=0;fillColor={BLUE};strokeColor=none;")
        self.box("", width * .55 + 20, 20, width * .45 - 40, 6,
                 f"rounded=0;fillColor={PURPLE};strokeColor=none;")
        self.text(f"<b>{title}</b>", 40, 40, width - 80, 50, 28)
        self.text(subtitle, 40, 100, width - 80, 40, 16, GRAY)
        self.text("Legend: DEFAULT = included in the selected local/cloud path | OPT-IN = explicit test | GATE = human or policy decision",
                  40, height - 90, width - 80, 30, 13, GRAY)
        self.text("Scorecard Intelligence Workbench | 2026-11-17 | Icons: Microsoft Azure V24 + Entra + official Content Understanding artwork",
                  40, height - 50, width - 80, 24, 11, GRAY)

    def box(self, value, x, y, w, h, style, ident=None):
        self.n += 1
        ident = ident or f"c{self.n}"
        cell = ET.SubElement(self.root, "mxCell", id=ident, value=value,
                             style=style + "html=1;fontFamily=Segoe UI;", vertex="1", parent="1")
        ET.SubElement(cell, "mxGeometry", x=str(x), y=str(y), width=str(w), height=str(h), **{"as": "geometry"})
        return ident

    def text(self, value, x, y, w, h, size=15, color="#201F1E"):
        return self.box(value, x, y, w, h,
                        f"text;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize={size};fontColor={color};")

    def lane(self, title, key, x, y, w, h, color=BLUE):
        return self.box(title, x, y, w, h,
                        f"shape=label;rounded=1;arcSize=3;whiteSpace=wrap;fillColor=#F8F7F6;strokeColor={color};"
                        f"verticalAlign=top;align=left;fontSize=17;fontStyle=1;fontColor={color};"
                        f"spacingTop=12;spacingLeft=48;imageWidth=28;imageHeight=28;imageVerticalAlign=top;iconKey={key};")

    def tile(self, title, detail, key, x, y, w=300, h=90, tag="DEFAULT", color=BLUE):
        ident = self.box(f"<b>{title}</b><br><font color='{GRAY}'>{detail}</font>", x, y, w, h,
                         f"shape=label;rounded=1;arcSize=10;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor={color};"
                         f"strokeWidth=1.5;fontSize=15;align=left;verticalAlign=middle;spacingLeft=62;spacingRight=12;"
                         f"imageWidth=40;imageHeight=40;imageAlign=left;iconKey={key};")
        if tag:
            c = PURPLE if tag == "OPT-IN" else TEAL if tag == "GATE" else BLUE
            self.box(tag, x + w - 80, y - 10, 80, 20,
                     f"rounded=1;arcSize=50;fillColor={c};strokeColor=#FFFFFF;fontColor=#FFFFFF;fontSize=10;fontStyle=1;")
        return ident

    def diamond(self, label, x, y, w=260, h=140):
        return self.box(label, x, y, w, h,
                        f"rhombus;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor={BLUE};fontSize=15;")

    def edge(self, src, dst, label="", vertical=False, dashed=False, reverse=False,
             points=None, anchors=None):
        self.n += 1
        style = (f"edgeStyle=orthogonalEdgeStyle;rounded=0;endArrow=classic;html=1;strokeColor={BLUE};"
                 f"strokeWidth=2;dashed={int(dashed)};fontSize=13;labelBackgroundColor=#FFFFFF;")
        style += anchors or ("exitX=0.5;exitY=1;entryX=0.5;entryY=0;" if vertical else
                             "exitX=0;exitY=0.5;entryX=1;entryY=0.5;" if reverse else
                             "exitX=1;exitY=0.5;entryX=0;entryY=0.5;")
        cell = ET.SubElement(self.root, "mxCell", id=f"e{self.n}", value=label, style=style,
                             edge="1", parent="1", source=src, target=dst)
        geom = ET.SubElement(cell, "mxGeometry", relative="1", **{"as": "geometry"})
        if points:
            array = ET.SubElement(geom, "Array", **{"as": "points"})
            for x, y in points:
                ET.SubElement(array, "mxPoint", x=str(x), y=str(y))

    def save(self):
        # Embed the copied Microsoft SVGs so desktop rendering never needs a network.
        for cell in self.root.findall("mxCell"):
            style = cell.get("style", "")
            if "iconKey=" in style:
                key = style.split("iconKey=")[1].split(";")[0]
                svg = base64.b64encode((OUT / "icons" / f"{key}.svg").read_bytes()).decode()
                cell.set("style", style + f"image=data:image/svg+xml,{svg};")
        ET.indent(self.doc)
        content = ET.tostring(self.doc, encoding="utf-8", xml_declaration=True)
        target = OUT / f"{self.name}.drawio"
        if not target.exists() or target.read_bytes() != content:
            target.write_bytes(content)


def steps(name, title, subtitle, rows):
    d = Diagram(name, title, subtitle)
    last = None
    for i, (head, detail, icon, tag) in enumerate(rows):
        row = i // 3
        col = i % 3 if row % 2 == 0 else 2 - i % 3
        x, y = 60 + col * 510, 210 + row * 250
        d.lane(f"Step {i + 1}", icon, x - 10, y - 50, 470, 200)
        current = d.tile(head, detail, icon, x + 10, y + 15, 430, 105, tag)
        if last:
            d.edge(last, current, vertical=i % 3 == 0, reverse=bool(row % 2))
        last = current
    d.save()


def main():
    d = Diagram("scorecard-intelligence-workbench-architecture", "Evidence-led scorecard workbench",
                "Local rehearsal stays local; cloud AI deploys by default; humans alone approve publication.", 1900, 1050)
    columns = [
        ("Sources + extraction", "file", [("Uploaded bytes", "Local structured / approved cloud sources", "file", "DEFAULT"),
                             ("Content Understanding", "Cloud default; authorized whole source", "content-understanding", "DEFAULT")]),
        ("Trusted server", "container-apps", [("Node.js 24", "Validate session, file, scope and input", "container-apps", "DEFAULT"),
                                             ("Evidence normalization", "Validate fields, confidence and source spans", "gear", "DEFAULT")]),
        ("Policy and intelligence", "entra-id", [("Authorization first", "PKCE access token; filter allowed evidence", "entra-id", "GATE"),
                                                ("Explanations", "Local deterministic / cloud Responses", "azure-openai", "DEFAULT")]),
        ("Human workflow", "users", [("Confirm and approve", "Reviewer confirms; manager approves", "users", "GATE"),
                                     ("Publish and freeze", "Rules + evidence in immutable snapshot", "keys", "GATE")]),
        ("State and operations", "cosmos-db", [("Persistent state", "Atomic JSON locally / Cosmos in Azure", "cosmos-db", "DEFAULT"),
                                              ("Identity and logs", "Managed identity; sanitized telemetry", "managed-identity", "DEFAULT")]),
    ]
    ids = []
    for i, (title, icon, items) in enumerate(columns):
        x = 40 + i * 370
        d.lane(title, icon, x, 180, 350, 650, PURPLE if i == 2 else BLUE)
        group = []
        for j, (head, detail, key, tag) in enumerate(items):
            group.append(d.tile(head, detail, key, x + 20, 280 + j * 260, 310, 120, tag))
        if i in (1, 2, 3):
            d.edge(group[0], group[1], vertical=True)
        ids.append(group[0])
    for i in range(3):
        d.edge(ids[i], ids[i + 1])
    d.text("Bounded single-workbench proof of concept. Synthetic local rehearsal is not cloud validation or a production security certification.",
           60, 850, 1760, 45, 17)
    d.save()

    d = Diagram("service-catalog", "Service catalog", "Inventory by responsibility; Azure services are a deployment path, not a claim of live validation.", 1600, 1050)
    groups = [
        ("Experience and runtime", "container-apps", [("Browser + Node.js", "Accessible UI and server API", "code", "DEFAULT"),
                                                    ("Azure Container Apps", "Cloud default; single replica host", "container-apps", "DEFAULT")]),
        ("Data and extraction", "cosmos-db", [("Cosmos DB for NoSQL", "Cloud default; ETag concurrency", "cosmos-db", "DEFAULT"),
                                              ("Content Understanding", "Cloud default; custom fields + grounding", "content-understanding", "DEFAULT")]),
        ("Identity and build", "entra-id", [("Microsoft Entra ID", "Automatic API + SPA; operator manager only", "entra-id", "GATE"),
                                           ("Container Registry", "Cloud default; remote build and pull", "container-registry", "DEFAULT")]),
        ("Explanations and observability", "azure-openai", [("Azure OpenAI", "Cloud default; grounded Responses", "azure-openai", "DEFAULT"),
                                                           ("Monitor resources", "Cloud default; Insights + Log Analytics", "application-insights", "DEFAULT")]),
    ]
    for i, (title, icon, items) in enumerate(groups):
        x, y = 40 + (i % 2) * 780, 170 + (i // 2) * 350
        d.lane(title, icon, x, y, 740, 300)
        for j, item in enumerate(items):
            d.tile(item[0], item[1], item[2], x + 20 + j * 360, y + 100, 340, 125, item[3])
    d.text("How to read: local rehearsal needs no Azure account. One guarded azd up deploys all cloud resources; directory permissions and model quota remain prerequisites.",
           50, 875, 1500, 50, 16)
    d.save()

    steps("prerequisites-map", "Prerequisite map", "Complete the local lane first; cloud identity, provider availability and permissions are independent gates.", [
        ("Local tools", "Node.js 24, npm, Python; generated samples", "dev-console", "DEFAULT"),
        ("Target subscription", "Confirm tenant, subscription and region", "resource-group", "GATE"),
        ("Human permissions", "Azure roles + directory app/assignment authority", "entra-id", "GATE"),
        ("Runtime identity", "Auto API + SPA; operator manager; data roles", "managed-identity", "GATE"),
        ("Content Understanding", "Cloud default; completion + embedding quota", "content-understanding", "DEFAULT"),
        ("Budget and policy", "Set spending controls; review data residency", "cost-management", "GATE")])
    steps("azd-deployment-flow", "Azure deployment flow", "Single azd up: explicit verified target, automatic directory bootstrap, default-on cloud services and application.", [
        ("Preup: verify target", "Resolve tenant/subscription/region; both logins", "entra-id", "GATE"),
        ("Bootstrap API + SPA", "Scope, roles, service principals; operator manager", "app-registrations", "DEFAULT"),
        ("Validate + provision", "Strict guard; Bicep includes CU + Responses", "resource-group", "DEFAULT"),
        ("Postprovision setup", "Merge callback; CU mappings/analyzer; local IDs", "content-understanding", "DEFAULT"),
        ("Build + deploy revision", "Remote image build; managed-identity runtime", "container-apps", "DEFAULT"),
        ("Verify and record", "Health, token roles, Cosmos restart persistence", "application-insights", "GATE")])
    steps("manual-deployment-steps", "Manual deployment map", "Portal or CLI must create the same resources and bindings; a running container alone is not parity.", [
        ("Bootstrap + foundation", "Verify target; API/SPA; group, logs, telemetry", "resource-group", "DEFAULT"),
        ("Create identity + registry", "User-assigned identity, image build, pull role", "container-registry", "DEFAULT"),
        ("Create Cosmos state", "Database, /id container and data role", "cosmos-db", "DEFAULT"),
        ("Create AI services", "CU models/analyzer + separate Responses model", "content-understanding", "DEFAULT"),
        ("Create application", "Entra, managed identity; merge exact callback", "container-apps", "DEFAULT"),
        ("Compare and test", "Match outputs; run the same cloud tests", "gear", "GATE")])
    steps("walkthrough", "Presenter walkthrough", "Tell a reproducible evidence story without presenting deterministic rehearsal as a live model.", [
        ("Declare mode", "Show synthetic data and provider labels", "users", "DEFAULT"),
        ("Upload real bytes", "Local structured files; authorized whole sources to CU", "file", "DEFAULT"),
        ("Correct and confirm", "Explain threshold status and uncertainty", "gear", "GATE"),
        ("Ask with evidence", "Citations or explicit abstention", "azure-openai", "DEFAULT"),
        ("Approve the draft", "Manager approves action and period", "users", "GATE"),
        ("Publish and freeze", "Immutable history; reject later edits", "keys", "GATE")])
    steps("configuration-flow", "Configuration flow", "Domain vocabulary is data; identity and provider switches remain explicit deployment/runtime choices.", [
        ("Template defaults", "Committed neutral configuration + domain", "file", "DEFAULT"),
        ("Local configuration", "Ignored demo-ids.local.json replaces template", "folder", "DEFAULT"),
        ("Process environment", "Explicit runtime and provider overrides", "gear", "GATE"),
        ("Bootstrap + azd inputs", "Explicit target; identity IDs; cloud AI defaults", "powershell", "DEFAULT"),
        ("Deployed settings", "Callback + analyzer; outputs; app revision", "container-apps", "DEFAULT"),
        ("Consumers", "Local parsers / CU schema; rules, UI and answers", "code", "DEFAULT")])
    steps("browser-authentication-flow", "Browser sign-in and API authorization",
          "Bootstrap creates or reuses API + public SPA; exact callback merged after provisioning; directory authority required.", [
        ("Read public settings", "/api/auth/config; no secret or source data", "gear", "GATE"),
        ("Redirect to Entra", "SPA client, API scope, state and S256 challenge", "entra-id", "GATE"),
        ("Validate callback", "/auth/callback; one-use transaction", "app-registrations", "GATE"),
        ("Exchange code", "SPA token endpoint; verifier; no client secret", "keys", "GATE"),
        ("Verify every API request", "Signature, v2, issuer, tenant, audience, scope, role", "container-apps", "GATE"),
        ("Read authorized evidence", "Memory-only bearer; source download via API", "file", "GATE")])

    d = Diagram("testing-matrix", "Verification matrix", "Fixture evidence, mocked cloud adapters and real Azure validation are different evidence classes.")
    headers = [("Local fixtures", "file"), ("Mocked Azure", "gear"), ("Live Azure", "container-apps")]
    for i, (label, icon) in enumerate(headers):
        d.tile(label, "Run status comes from test output", icon, 390 + i * 390, 180, 350, 90,
               "OPT-IN" if i == 2 else "DEFAULT")
    checks = [
        ("Parsing + grounded fields", ["LOCAL STRUCTURED", "CU CUSTOM SCHEMA", "NOT RUN"]),
        ("Roles + restricted data", ["REQUIRED", "TOKEN NEGATIVES", "NOT RUN"]),
        ("Approval + freeze", ["REQUIRED", "ETAG CONFLICT", "NOT RUN"]),
        ("Quality + abstention", ["TINY FIXTURES", "OUTPUT REJECTION", "NOT RUN"]),
        ("Restart persistence", ["ATOMIC JSON", "COSMOS CONTRACT", "NOT RUN"]),
    ]
    for j, (label, cells) in enumerate(checks):
        y = 320 + j * 85
        d.text(label, 45, y, 320, 55, 17)
        for i, value in enumerate(cells):
            color = GRAY if value == "NOT RUN" else BLUE
            d.box(value, 400 + i * 390, y, 330, 55,
                  f"rounded=1;fillColor={color};strokeColor=none;fontColor=#FFFFFF;fontSize=15;")
    d.save()

    d = Diagram("security-decision-flow", "Security and publication decisions", "Deny and abstain are useful outcomes; no prompt may receive evidence that the caller cannot read.", 1700, 1150)
    token = d.diamond("Valid server session<br>or Entra JWT?", 120, 180)
    deny = d.tile("Deny request", "No extraction call, records or source bytes", "keys", 30, 430, 340, 100, "GATE")
    scope = d.diamond("Evidence authorized<br>for this caller?", 650, 180)
    filterout = d.tile("Exclude evidence", "Also exclude citations, audit and aggregates", "entra-id", 550, 430, 430, 100, "GATE")
    answer = d.tile("Build answer inputs", "Only authorized records and source IDs", "azure-openai", 1170, 200, 400, 100)
    supported = d.diamond("Claims supported by<br>authorized evidence?", 1240, 410)
    abstain = d.tile("Abstain", "Reject unknown citations or numeric claims", "alerts", 1130, 670, 470, 100, "GATE")
    confirm = d.tile("Human confirmation", "Confirm records, then manager approval", "users", 120, 680, 420, 100, "GATE")
    publish = d.tile("Immutable publication", "Snapshot rules + evidence; reject changes", "cosmos-db", 650, 680, 420, 100, "GATE")
    d.edge(token, deny, "No", True)
    d.edge(token, scope, "Yes")
    d.edge(scope, filterout, "No", True)
    d.edge(scope, answer, "Yes")
    d.edge(answer, supported, vertical=True)
    d.edge(supported, abstain, "No", True)
    d.edge(supported, confirm, "Yes", points=[(1100, 480), (1100, 600), (330, 600)],
           anchors="exitX=0;exitY=0.5;entryX=0.5;entryY=0;")
    d.edge(confirm, publish, "Approved")
    d.text("CU requires whole-source authorization before model processing. Reject known restrictions before the call; output checks are not retroactive redaction. Human approval remains independent.",
           100, 880, 1500, 70, 18)
    d.save()

    d = Diagram("troubleshooting-decision-tree", "Troubleshooting decision tree", "Start with mode and authorization; do not fix a denied request by disabling a security boundary.", 1700, 1100)
    local = d.diamond("Does /health<br>respond?", 90, 180)
    process = d.tile("Runtime", "Check Node version, port and process logs", "container-apps", 30, 430, 370, 110)
    authorized = d.diamond("Is /api/session<br>authorized?", 630, 180)
    identity = d.tile("Microsoft Entra ID", "Check issuer, audience, tenant and roles", "entra-id", 560, 430, 410, 110, "GATE")
    providers = d.diamond("Does failure involve<br>an Azure provider?", 1190, 180)
    azure = d.tile("Content Understanding / answers", "Check analyzer, models, roles, grounding and polling", "content-understanding", 1130, 430, 470, 110, "DEFAULT")
    parse = d.tile("Local parser", "Check source bytes, aliases and warnings", "file", 100, 720, 440, 100)
    workflow = d.tile("Workflow conflict", "Reload ETag/version; confirm before publish", "cosmos-db", 660, 720, 450, 100, "GATE")
    d.edge(local, process, "No", True)
    d.edge(local, authorized, "Yes")
    d.edge(authorized, identity, "No", True)
    d.edge(authorized, providers, "Yes")
    d.edge(providers, azure, "Yes", True)
    d.edge(providers, parse, "No", points=[(1640, 250), (1640, 620), (320, 620)],
           anchors="exitX=1;exitY=0.5;entryX=0.5;entryY=0;")
    d.edge(parse, workflow, "If state conflict")
    d.save()

    d = Diagram("mode-comparison", "Local rehearsal and Azure deployment", "Local providers stay local; all cloud resources deploy by default after explicit target and permission checks.", 1600, 1000)
    lanes = [
        ("Local synthetic rehearsal", "dev-console", 40, [
            ("Identity", "Loopback-only server-issued role cookie", "users", "DEFAULT"),
            ("State", "Atomic JSON; one trusted process", "file", "DEFAULT"),
            ("Intelligence", "Real text extraction; deterministic answers", "gear", "DEFAULT")]),
        ("Azure deployment path", "container-apps", 820, [
            ("Identity", "Entra JWT + app role validation", "entra-id", "GATE"),
            ("State", "Cosmos DB + ETags; managed identity", "cosmos-db", "DEFAULT"),
            ("Intelligence", "Default CU custom fields + Responses", "content-understanding", "DEFAULT")]),
    ]
    for title, icon, x, items in lanes:
        d.lane(title, icon, x, 170, 740, 640)
        for j, item in enumerate(items):
            d.tile(item[0], item[1], item[2], x + 30, 270 + j * 170, 680, 100, item[3])
    d.text("Recommendation: rehearse locally, then deploy the full cloud path and validate identity, state and AI independently. Cloud deployment is billable.",
           50, 840, 1490, 60, 18, TEAL)
    d.save()

    d = Diagram("rule-assessment-flow", "Deterministic rule assessment",
                "Keep source ratings, internal status and optional baseline gaps separate; never invent missing annual evidence.", 1800, 1150)
    parsed = d.diamond("Known KPI and<br>numeric source value?", 80, 190)
    unresolved = d.tile("Unresolved evidence", "Missing / unknown; cannot confirm or publish", "alerts", 30, 470, 390, 110, "GATE")
    annual = d.diamond("Configured rule is<br>annual_cumulative?", 670, 190)
    thresholds = d.tile("Ordered thresholds", "Higher/lower target, watch, warning", "gear", 580, 470, 440, 110)
    complete = d.diamond("Required annual<br>evidence complete?", 1280, 190)
    abstain = d.tile("Abstain annual total", "No missing-month extrapolation", "alerts", 1190, 470, 500, 110, "GATE")
    annualvalue = d.tile("Explicit annual comparison", "Source YTD or complete unique monthly sum", "gear", 1120, 760, 570, 110)
    baseline = d.tile("Separate baseline comparison", "Only explicit baseline; keep provenance", "file", 100, 760, 650, 110)
    d.edge(parsed, unresolved, "No", True)
    d.edge(parsed, annual, "Yes")
    d.edge(annual, thresholds, "No", True)
    d.edge(annual, complete, "Yes")
    d.edge(complete, abstain, "No", True)
    d.edge(complete, annualvalue, "Yes", points=[(1730, 260), (1730, 700), (1405, 700)],
           anchors="exitX=1;exitY=0.5;entryX=0.5;entryY=0;")
    d.text("Source rating is preserved independently. Overall rollup remains undecided: show counts, not a fabricated composite grade.",
           70, 940, 1650, 55, 17)
    d.save()

    d = Diagram("scope-and-targets", "Scope, limits and starting targets",
                "Application guard values and proposed goals are not Azure service quotas or measured customer quality.", 1600, 1250)
    numbers = [
        ("15 MiB", "JSON request envelope", "Base64 overhead counts toward this bound", "file"),
        ("10 MiB", "Source-file bytes", "Larger uploads are rejected", "file"),
        ("100", "Local PDF pages", "Local parser guard; not an OCR quota", "file"),
        ("1.8 MB", "Serialized cloud state guard", "Bounded state; design external storage for scale", "cosmos-db"),
        ("60 s", "Azure adapter deadline", "Polling is bounded; no unbounded retry", "gear"),
        ("1", "Cloud application replica", "Not a scale-out benchmark", "container-apps"),
        ("100%", "Proposed citation resolution", "Starting target; measure actual fixtures", "file"),
        ("0", "Proposed restricted disclosures", "Starting target; negative tests required", "keys"),
        ("0", "Azure deployments validated here", "No tenant or subscription targeted", "resource-group"),
    ]
    for i, (number, title, note, icon) in enumerate(numbers):
        x, y = 50 + (i % 3) * 520, 190 + (i // 3) * 300
        d.lane(title, icon, x, y, 490, 250)
        d.text(number, x + 30, y + 55, 420, 65, 38, BLUE)
        d.text(note, x + 30, y + 140, 420, 80, 17, GRAY)
    d.save()


if __name__ == "__main__":
    main()
