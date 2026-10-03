"""Data migration: the "Ticket triage" WorkflowDefinition, so a fresh DB has it after `migrate`."""
from django.db import migrations


def create_ticket_workflow(apps, schema_editor):
    from triage.workflow import ensure_ticket_workflow
    ensure_ticket_workflow(apps.get_model('workflows', 'WorkflowDefinition'))


def remove_ticket_workflow(apps, schema_editor):
    from triage.workflow import TICKET_MODEL_LABEL, TICKET_WORKFLOW_SLUG
    WorkflowDefinition = apps.get_model('workflows', 'WorkflowDefinition')
    WorkflowDefinition.objects.filter(slug=TICKET_WORKFLOW_SLUG, model_label=TICKET_MODEL_LABEL, instances__isnull=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ('triage', '0001_initial'),
        ('workflows', '0001_initial'),
    ]

    operations = [
        migrations.RunPython(create_ticket_workflow, remove_ticket_workflow),
    ]
