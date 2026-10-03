import json

from core.utils.admin import BaseCoreAdmin, obj_to_link
from django.contrib import admin, messages
from django.core.exceptions import PermissionDenied, ValidationError
from django.utils.html import format_html, format_html_join

from .models import Building, Category, Contractor, Ticket, Unit


class UnitInline(admin.TabularInline):
    model = Unit
    extra = 0
    fields = ('number', 'deleted_at')
    readonly_fields = ('deleted_at',)


@admin.register(Building)
class BuildingAdmin(BaseCoreAdmin):
    list_display = ('name', 'address', 'unit_count', 'created_at')
    search_fields = ('name', 'address')
    inlines = [UnitInline]

    @admin.display(description='Lokale')
    def unit_count(self, obj):
        return obj.units.filter(deleted_at__isnull=True).count()


@admin.register(Unit)
class UnitAdmin(BaseCoreAdmin):
    list_display = ('number', 'building', 'created_at')
    list_filter = ('building',)
    search_fields = ('number', 'building__name')


@admin.register(Category)
class CategoryAdmin(BaseCoreAdmin):
    list_display = ('code', 'name', 'slug')
    search_fields = ('code', 'name')


@admin.register(Contractor)
class ContractorAdmin(BaseCoreAdmin):
    list_display = ('name', 'category', 'phone', 'email')
    list_filter = ('category',)
    search_fields = ('name', 'email', 'phone')


def _transition_action(name, label):
    def action(modeladmin, request, queryset):
        done, failed = 0, []
        for ticket in queryset:
            try:
                ticket.transition(name, request.user, note=f'Django admin: {label}')
                done += 1
            except (ValidationError, PermissionDenied) as e:
                failed.append(f'{ticket}: {"; ".join(getattr(e, "messages", [str(e)]))}')
        if done:
            modeladmin.message_user(request, f'{label}: {done} ticket(s)', messages.SUCCESS)
        for msg in failed:
            modeladmin.message_user(request, msg, messages.ERROR)

    action.__name__ = f'transition_{name}'
    action.short_description = f'Workflow: {label}'
    return action


@admin.register(Ticket)
class TicketAdmin(BaseCoreAdmin):
    list_display = ('short_guid', 'unit', 'category', 'priority', 'contractor', 'status', 'created_at')
    list_filter = ('status', 'priority', 'category', 'contractor', 'unit__building')
    search_fields = ('description', 'reporter_name', 'unit__number', 'guid')
    list_select_related = ('unit__building', 'category', 'contractor')
    exclude = ('ai_suggestion',)
    readonly_fields = ('guid', 'status', 'ai_suggestion_pretty', 'workflow_info')
    actions = [
        _transition_action('propose', 'Propose'),
        _transition_action('approve', 'Approve'),
        _transition_action('reject', 'Reject / send back'),
        _transition_action('assign', 'Assign'),
        _transition_action('close', 'Close'),
    ]

    @admin.display(description='ID')
    def short_guid(self, obj):
        return str(obj.guid)[:8]

    @admin.display(description='AI suggestion')
    def ai_suggestion_pretty(self, obj):
        if not obj.ai_suggestion:
            return '—'
        return format_html('<pre style="white-space: pre-wrap;">{}</pre>',
                           json.dumps(obj.ai_suggestion, indent=2, ensure_ascii=False))

    @admin.display(description='Workflow')
    def workflow_info(self, obj):
        instance = obj.workflow_instance if obj.pk else None
        if instance is None:
            return '—'
        logs = format_html_join(
            '', '<li>{} → {} · {} · {} · {}</li>',
            ((log.from_state or '∅', log.to_state, log.timestamp.strftime('%Y-%m-%d %H:%M'), log.transitioned_by or '—', log.note)
             for log in instance.transition_logs.select_related('transitioned_by').order_by('timestamp')),
        )
        return format_html('<p>Stan: <b>{}</b> ({})</p><ul>{}</ul>', instance.current_state, obj_to_link(instance), logs)
