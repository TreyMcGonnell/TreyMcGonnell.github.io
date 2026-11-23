"""I4: the personal-details scan flags phone numbers, addresses, birth dates and ID numbers, and nothing else."""
import importlib.util

from .conftest import ROOT

spec = importlib.util.spec_from_file_location("check_pii", ROOT / "scripts" / "check_pii.py")
check_pii = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_pii)


def test_flags_personal_details(tmp_path):
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "bad.md").write_text(
        "Call me at (859) 555-0142.\nI live at 1200 Maple Grove Drive.\nI was born on 3/14/2005.\nSSN 123-45-6789\n", encoding="utf-8")
    kinds = {p.split("possible ")[1].split(":")[0] for p in check_pii.scan(tmp_path)}
    assert kinds == {"phone number", "street address", "birth date", "ID number"}


def test_ordinary_content_passes(tmp_path):
    (tmp_path / "trey.md").write_text(
        "Trey studies data science at NKU, class of 2028. trey-lm runs Llama 3.2 3B on 28 layers.\n", encoding="utf-8")
    assert check_pii.scan(tmp_path) == []
