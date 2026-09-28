"""The existing OpenJarvis builder reduced to one explicit local stack."""

from __future__ import annotations
from openjarvis.core.config import load_config
from openjarvis.core.events import EventBus
from openjarvis.engine.ollama import OllamaEngine
from openjarvis.system.core import JarvisSystem


class SystemBuilder:
    def __init__(self, config=None, *, config_path=None):
        self._config = config if config is not None else load_config(config_path)

    def build(self):
        config = self._config.validate()
        engine = OllamaEngine(
            config.engine.host,
            timeout=config.engine.timeout,
            keep_alive=config.engine.keep_alive or None,
        )
        memory = None
        browser_session = None
        knowledge = None
        try:
            from pathlib import Path
            from openjarvis.tools.calculator import CalculatorTool
            from openjarvis.tools.file_read import FileReadTool

            tools = {}
            if "calculator" in config.tools.enabled:
                tools["calculator"] = CalculatorTool()
            if "file_read" in config.tools.enabled:
                root = Path(config.tools.workspace).expanduser().resolve()
                root.mkdir(parents=True, exist_ok=True)
                tools["file_read"] = FileReadTool(allowed_dirs=[str(root)])
            if config.memory.enabled and {"memory_store", "memory_retrieve"}.intersection(
                config.tools.enabled
            ):
                from openjarvis.tools.storage.sqlite import SQLiteMemory
                from openjarvis.tools.storage_tools import MemoryStoreTool, MemoryRetrieveTool

                memory = SQLiteMemory(Path(config.memory.db_path).expanduser())
                for tool in (MemoryStoreTool(memory), MemoryRetrieveTool(memory)):
                    if tool.spec.name in config.tools.enabled:
                        tools[tool.spec.name] = tool
            if config.knowledge.enabled and set(config.tools.enabled).intersection(
                ("notes_search", "notes_read", "notes_write", "notes_append")
            ):
                from openjarvis.tools.knowledge import MarkdownVault, NotesTool

                knowledge = MarkdownVault(config.knowledge.vault_path)
                for name in ("notes_search", "notes_read", "notes_write", "notes_append"):
                    if name in config.tools.enabled:
                        tools[name] = NotesTool(knowledge, name)
            if config.tools.browser:
                from openjarvis.tools.browser import (
                    BrowserNavigateTool,
                    BrowserClickTool,
                    BrowserTypeTool,
                    BrowserExtractTool,
                    _BrowserSession,
                )

                browser_session = _BrowserSession(config.browser)
                for cls in (
                    BrowserNavigateTool,
                    BrowserClickTool,
                    BrowserTypeTool,
                    BrowserExtractTool,
                ):
                    tool = cls(session=browser_session)
                    if tool.spec.name in config.tools.enabled:
                        tools[tool.spec.name] = tool
            return JarvisSystem(
                config=config,
                bus=EventBus(),
                engine=engine,
                tools=tools,
                memory_backend=memory,
                knowledge_vault=knowledge,
                browser_session=browser_session,
            )
        except BaseException:
            if knowledge is not None:
                knowledge.close()
            if memory is not None:
                memory.close()
            if browser_session is not None:
                browser_session.close()
            engine.close()
            raise
