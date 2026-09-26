"""Tests never consult a personal Lite config."""

import pytest
from openjarvis.core import config


@pytest.fixture(autouse=True)
def isolated_config(monkeypatch, tmp_path):
    monkeypatch.delenv("OPENJARVIS_CONFIG", raising=False)
    monkeypatch.setattr(config, "DEFAULT_CONFIG_PATH", tmp_path / "config.toml")
