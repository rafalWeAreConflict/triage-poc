from django.apps import AppConfig


class TriageConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'triage'
    verbose_name = 'Ticket triage'

    def ready(self):
        from . import signals  # noqa: F401
