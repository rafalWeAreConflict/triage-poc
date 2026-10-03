from copilot.views import copilot_agui, copilot_whoami
from django.urls import path

urlpatterns = [
    path('agui/', copilot_agui, name='copilot-agui'),
    path('whoami/', copilot_whoami, name='copilot-whoami'),
]
