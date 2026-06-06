const { body, param } = require('express-validator');

const citiesValidators = {
  createCity: [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('City name is required')
      .isLength({ max: 100 })
      .withMessage('City name must be 100 characters or fewer'),

    body('isActive')
      .optional()
      .isBoolean()
      .withMessage('isActive must be a boolean'),

    body('imageUrl')
      .optional({ nullable: true })
      .isURL()
      .withMessage('imageUrl must be a valid URL'),
  ],

  updateCity: [
    param('id').isInt({ min: 1 }).withMessage('Invalid city ID'),

    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('City name cannot be empty')
      .isLength({ max: 100 })
      .withMessage('City name must be 100 characters or fewer'),

    body('isActive')
      .optional()
      .isBoolean()
      .withMessage('isActive must be a boolean'),

    body('imageUrl')
      .optional({ nullable: true })
      .isURL()
      .withMessage('imageUrl must be a valid URL'),
  ],

  createArea: [
    param('id').isInt({ min: 1 }).withMessage('Invalid city ID'),

    body('name')
      .trim()
      .notEmpty()
      .withMessage('Area name is required')
      .isLength({ max: 100 })
      .withMessage('Area name must be 100 characters or fewer'),

    body('imageUrl')
      .optional({ nullable: true })
      .isURL()
      .withMessage('imageUrl must be a valid URL'),
  ],

  updateArea: [
    param('id').isInt({ min: 1 }).withMessage('Invalid city ID'),
    param('areaId').isInt({ min: 1 }).withMessage('Invalid area ID'),

    body('name')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Area name cannot be empty')
      .isLength({ max: 100 })
      .withMessage('Area name must be 100 characters or fewer'),

    body('imageUrl')
      .optional({ nullable: true })
      .isURL()
      .withMessage('imageUrl must be a valid URL'),
  ],
};

module.exports = citiesValidators;
