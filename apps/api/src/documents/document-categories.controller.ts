import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@policymanager/shared';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { DocumentCategoriesService } from './document-categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';

/**
 * Hierarchical document categories (folders). Reading the tree requires
 * `document.read`; creating a category requires `document.write`.
 */
@ApiTags('document-categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('document-categories')
export class DocumentCategoriesController {
  constructor(private readonly categories: DocumentCategoriesService) {}

  @Get()
  @RequirePermission(PERMISSIONS.DOCUMENT_READ)
  @ApiOperation({ summary: 'Get the category tree.' })
  tree() {
    return this.categories.tree();
  }

  @Post()
  @RequirePermission(PERMISSIONS.DOCUMENT_WRITE)
  @ApiOperation({ summary: 'Create a category (optionally nested under a parent).' })
  create(@Body() dto: CreateCategoryDto) {
    return this.categories.create(dto);
  }
}
