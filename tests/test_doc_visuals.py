"""Documentation checks runnable with the Python standard library."""
import subprocess
import sys
import unittest
import base64
import re
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class DocumentationVisualTests(unittest.TestCase):
    def test_docs_meet_visual_standard(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "lint_doc_visuals.py"),
             "--root", str(ROOT), "--strict", "--quiet"],
            capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_diagram_exports_are_current(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "export_diagrams.py"),
             str(ROOT / "docs" / "assets"), "--check"],
            capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_diagram_icons_match_shipped_offline_artwork(self):
        assets = ROOT / "docs" / "assets"
        for diagram in assets.glob("*.drawio"):
            for cell in ET.parse(diagram).findall(".//mxCell"):
                style = cell.get("style", "")
                match = re.search(r"(?:^|;)iconKey=([^;]+)", style)
                if not match:
                    continue
                with self.subTest(diagram=diagram.name, cell=cell.get("id")):
                    icon = assets / "icons" / f"{match[1]}.svg"
                    self.assertTrue(icon.is_file(), f"Missing official icon {icon.name}")
                    expected = base64.b64encode(icon.read_bytes()).decode("ascii")
                    self.assertIn(f"image=data:image/svg+xml,{expected};", style,
                                  "Diagram embeds missing/stale artwork; re-embed and export")


if __name__ == "__main__":
    unittest.main()
