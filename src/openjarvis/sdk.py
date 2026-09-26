"""Lite SDK keeps OpenJarvis's builder/system entry points."""

from openjarvis.system import JarvisSystem, SystemBuilder


class Jarvis:
    def __init__(self, config_path=None):
        self.system = SystemBuilder(config_path=config_path).build()

    def ask(self, query, **kwargs):
        return self.system.ask(query, **kwargs)

    def close(self):
        self.system.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


__all__ = ["Jarvis", "JarvisSystem", "SystemBuilder"]
