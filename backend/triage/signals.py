"""Keep ``Ticket.status`` mirrored from its WorkflowInstance (the source of truth)."""
from django.contrib.contenttypes.models import ContentType
from django.db.models.signals import post_save
from django.dispatch import receiver
from workflows.models import WorkflowInstance

from .models import Ticket


@receiver(post_save, sender=WorkflowInstance, dispatch_uid='triage_sync_ticket_status')
def sync_ticket_status(sender, instance, **kwargs):
    if instance.content_type_id != ContentType.objects.get_for_model(Ticket).pk:
        return
    # queryset.update(): no recursion into Ticket.save; the audit trail is the engine's TransitionLog.
    Ticket.objects.filter(pk=instance.object_id).exclude(status=instance.current_state).update(status=instance.current_state)
